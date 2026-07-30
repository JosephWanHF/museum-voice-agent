import { GoogleGenAI, Modality, type Session } from "@google/genai";
import html2canvas from "html2canvas-pro";
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import type { PlayingAudio, VisualPanel, VisualResult } from "./types";

export const SYSTEM_PROMPT = `You are the resident guide for Vibe Museum, a place where a painting becomes an original instrumental piece. Speak like someone standing with the visitor in the gallery: notice light, colour, texture, movement, and the emotional temperature of the work, then connect those observations to rhythm, harmony, space, and instrumentation. Have a point of viewâ€”favour a clear creative choice over vague praiseâ€”and help the visitor shape a music brief they can act on. Keep replies to one or two short sentences, because long answers are painful to listen to.

Messages beginning with [app state] are silent context and must never be read out. Only call look_at_screen for questions about how something LOOKS. Your tools are exactly the ones provided in this session, you cannot inspect or connect to any external tool server, and you must never claim to have checked your own tools.

You can see whenever a video source is active, and only then. You can act on this app through your tools, and you can generate images, sound effects and music. You do not choose which video source is on. If asked to look and no source is active, say the camera is off and ask them to turn it on. Use search_artwork whenever a visitor asks about a specific artwork so the fixed window can show pictures; use the creative tools when they ask to make something for the gallery.`;

const VOICE_TOKEN_URL = "https://workshop-mcp-production.up.railway.app/api/voice-token";
const CAPTURE_SAMPLE_RATE = 16_000;
const PLAYBACK_SAMPLE_RATE = 24_000;
const CAMERA_FRAME_INTERVAL_MS = 5_000;
const WORKSHOP_API_URL = "https://workshop-mcp-production.up.railway.app";

type TranscriptRole = "You" | "Vibe Museum";

interface Transcript {
  id: number;
  role: TranscriptRole;
  text: string;
}

interface VoiceTokenResponse {
  token: string;
  apiVersion: string;
}

interface LiveVoiceAgentProps {
  screenContainerRef: RefObject<HTMLDivElement>;
  visualPanel: VisualPanel | null;
  playingAudio: PlayingAudio | null;
  onVisualPanelChange: (panel: VisualPanel | null) => void;
  onPlayingAudioChange: (audio: PlayingAudio | null) => void;
}

interface ActionDefinition {
  description: string;
  parameters: Record<string, unknown>;
  run: (parameters: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

interface CommonsImageInfo {
  thumburl?: string;
  url?: string;
}

interface CommonsPage {
  title?: string;
  imageinfo?: CommonsImageInfo[];
}

interface CommonsSearchResponse {
  query?: { pages?: Record<string, CommonsPage> };
}

function getWorkshopApiKey(): string {
  const apiKey = import.meta.env.VITE_WORKSHOP_API_KEY;
  if (!apiKey || apiKey === "replace-with-your-workshop-api-key") {
    throw new Error("Set VITE_WORKSHOP_API_KEY in a local .env file before starting a live session.");
  }
  return apiKey;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function base64ToPcm16(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  const pcm = new Float32Array(Math.floor(bytes.byteLength / 2));
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < pcm.length; index += 1) {
    pcm[index] = view.getInt16(index * 2, true) / 0x8000;
  }
  return pcm;
}

async function requestVoiceToken(): Promise<string> {
  const response = await fetch(VOICE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": getWorkshopApiKey()
    },
    body: "{}"
  });

  if (!response.ok) {
    throw new Error(`Could not get a voice token (${response.status}).`);
  }

  const payload = (await response.json()) as VoiceTokenResponse;
  if (!payload.token) {
    throw new Error("The workshop server returned no voice token.");
  }
  if (payload.apiVersion !== "v1alpha") {
    throw new Error(`The workshop server returned unsupported API version ${payload.apiVersion}.`);
  }
  return payload.token;
}

export function LiveVoiceAgent({
  screenContainerRef,
  visualPanel,
  playingAudio,
  onVisualPanelChange,
  onPlayingAudioChange
}: LiveVoiceAgentProps) {
  const [systemPrompt, setSystemPrompt] = useState(SYSTEM_PROMPT);
  const [connectionStatus, setConnectionStatus] = useState("Offline");
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isGuideEditorOpen, setIsGuideEditorOpen] = useState(false);
  const [typedMessage, setTypedMessage] = useState("");

  const sessionRef = useRef<Session | null>(null);
  const captureContextRef = useRef<AudioContext | null>(null);
  const playbackContextRef = useRef<AudioContext | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const captureNodeRef = useRef<AudioWorkletNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const frameCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoTimerRef = useRef<number | null>(null);
  const playbackSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const nextPlaybackTimeRef = useRef(0);
  const resumptionHandleRef = useRef<string | undefined>(undefined);
  const reconnectTimerRef = useRef<number | null>(null);
  const shouldReconnectRef = useRef(false);
  const isConnectingRef = useRef(false);
  const connectionIdRef = useRef(0);
  const systemPromptRef = useRef(systemPrompt);
  const transcriptIdRef = useRef(0);
  const stateDescriptionRef = useRef("Screen shows the Vibe Museum welcome view; active video source: none.");
  const statePushTimerRef = useRef<number | null>(null);
  const statePushPendingRef = useRef(false);
  const modelReplyInProgressRef = useRef(false);
  const userTurnStatePushedRef = useRef(false);
  const generatedAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    systemPromptRef.current = systemPrompt;
  }, [systemPrompt]);

  function activeVideoSource(): "camera" | "none" {
    return cameraStreamRef.current?.getVideoTracks().some((track) => track.readyState === "live") ? "camera" : "none";
  }

  function describeState(): string {
    const visualDescription = visualPanel
      ? `${visualPanel.items.length} artwork image${visualPanel.items.length === 1 ? "" : "s"} for ${visualPanel.title}`
      : "the Vibe Museum welcome view";
    const audioDescription = playingAudio ? `; ${playingAudio.label} is playing` : "";
    const guideDescription = isGuideEditorOpen ? "; guide settings are open" : "";
    return `Screen shows ${visualDescription}${audioDescription}${guideDescription}; active video source: ${activeVideoSource()}.`;
  }

  function pushSilentState() {
    const session = sessionRef.current;
    if (!session) return;
    session.sendClientContent({
      turns: [{ role: "user", parts: [{ text: `[app state] ${stateDescriptionRef.current}` }] }],
      turnComplete: false
    });
  }

  function scheduleSilentStatePush() {
    if (statePushTimerRef.current !== null) {
      window.clearTimeout(statePushTimerRef.current);
    }
    statePushTimerRef.current = window.setTimeout(() => {
      statePushTimerRef.current = null;
      if (modelReplyInProgressRef.current) {
        statePushPendingRef.current = true;
        return;
      }
      pushSilentState();
    }, 600);
  }

  useEffect(() => {
    stateDescriptionRef.current = describeState();
    if (sessionRef.current) {
      scheduleSilentStatePush();
    }
  }, [cameraEnabled, isGuideEditorOpen, playingAudio, visualPanel]);

  function appendTranscript(role: TranscriptRole, text?: string) {
    const nextText = text?.trim();
    if (!nextText) return;

    setTranscripts((current) => {
      const previous = current[current.length - 1];
      if (!previous || previous.role !== role) {
        transcriptIdRef.current += 1;
        return [...current, { id: transcriptIdRef.current, role, text: nextText }];
      }

      const mergedText = nextText.startsWith(previous.text)
        ? nextText
        : previous.text.endsWith(nextText)
          ? previous.text
          : `${previous.text}${previous.text.endsWith(" ") ? "" : " "}${nextText}`;
      return [...current.slice(0, -1), { ...previous, text: mergedText }];
    });
  }

  function clearQueuedPlayback() {
    for (const source of playbackSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // A source that has already finished cannot be stopped again.
      }
      source.disconnect();
    }
    playbackSourcesRef.current = [];
    nextPlaybackTimeRef.current = playbackContextRef.current?.currentTime ?? 0;
  }

  function playAudioChunk(data: string) {
    const playbackContext = playbackContextRef.current;
    if (!playbackContext || playbackContext.state === "closed") return;

    const pcm = base64ToPcm16(data);
    if (!pcm.length) return;

    const audioBuffer = playbackContext.createBuffer(1, pcm.length, PLAYBACK_SAMPLE_RATE);
    audioBuffer.getChannelData(0).set(pcm);

    const source = playbackContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(playbackContext.destination);
    const startAt = Math.max(playbackContext.currentTime, nextPlaybackTimeRef.current);
    source.start(startAt);
    nextPlaybackTimeRef.current = startAt + audioBuffer.duration;
    playbackSourcesRef.current.push(source);

    source.addEventListener("ended", () => {
      playbackSourcesRef.current = playbackSourcesRef.current.filter((item) => item !== source);
      source.disconnect();
    });
  }

  function stopCameraFrames() {
    if (videoTimerRef.current !== null) {
      window.clearInterval(videoTimerRef.current);
      videoTimerRef.current = null;
    }
  }

  function sendCameraFrame() {
    const video = videoRef.current;
    const session = sessionRef.current;
    if (!video || !session || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    const canvas = frameCanvasRef.current ?? document.createElement("canvas");
    frameCanvasRef.current = canvas;
    const sourceWidth = video.videoWidth || 640;
    const sourceHeight = video.videoHeight || 480;
    const targetWidth = Math.min(sourceWidth, 640);
    canvas.width = targetWidth;
    canvas.height = Math.round((sourceHeight / sourceWidth) * targetWidth);

    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/jpeg", 0.8).split(",")[1];
    if (data) {
      session.sendRealtimeInput({ video: { data, mimeType: "image/jpeg" } });
    }
  }

  function startCameraFrames() {
    if (!cameraStreamRef.current || videoTimerRef.current !== null) return;
    sendCameraFrame();
    videoTimerRef.current = window.setInterval(sendCameraFrame, CAMERA_FRAME_INTERVAL_MS);
  }

  function stopCamera() {
    stopCameraFrames();
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraEnabled(false);
  }

  function stopMicrophoneCapture() {
    captureNodeRef.current?.disconnect();
    silentGainRef.current?.disconnect();
    captureNodeRef.current = null;
    silentGainRef.current = null;
    microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
    microphoneStreamRef.current = null;

    const context = captureContextRef.current;
    captureContextRef.current = null;
    if (context && context.state !== "closed") {
      void context.close();
    }
  }

  function closePlaybackContext() {
    clearQueuedPlayback();
    const context = playbackContextRef.current;
    playbackContextRef.current = null;
    if (context && context.state !== "closed") {
      void context.close();
    }
  }

  async function searchArtwork(query: string): Promise<Record<string, unknown>> {
    const searchTerm = query.trim();
    if (!searchTerm) {
      return { matching: 0, error: "An artwork search needs a title, artist, or description." };
    }

    const searchUrl = new URL("https://commons.wikimedia.org/w/api.php");
    searchUrl.search = new URLSearchParams({
      action: "query",
      format: "json",
      origin: "*",
      generator: "search",
      gsrsearch: `${searchTerm} filetype:bitmap`,
      gsrnamespace: "6",
      gsrlimit: "6",
      prop: "imageinfo",
      iiprop: "url",
      iiurlwidth: "640"
    }).toString();

    const response = await fetch(searchUrl);
    if (!response.ok) {
      return { matching: 0, error: `Artwork search failed (${response.status}).` };
    }

    const payload = (await response.json()) as CommonsSearchResponse;
    const matches: VisualResult[] = Object.values(payload.query?.pages ?? {})
      .map((page): VisualResult | null => {
        const image = page.imageinfo?.[0];
        const imageUrl = image?.thumburl || image?.url;
        if (!imageUrl || !page.title) return null;
        return {
          title: page.title.replace(/^File:/, ""),
          imageUrl,
          sourceUrl: image.url || imageUrl
        };
      })
      .filter((item): item is VisualResult => item !== null);

    if (matches.length) {
      onVisualPanelChange({
        title: searchTerm,
        subtitle: `${matches.length} image${matches.length === 1 ? "" : "s"} found on Wikimedia Commons`,
        items: matches
      });
    }

    return { matching: matches.length, titles: matches.map((item) => item.title) };
  }

  async function requestGeneration(path: "/api/image" | "/api/sfx" | "/api/music", body: Record<string, unknown>) {
    const response = await fetch(`${WORKSHOP_API_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": getWorkshopApiKey()
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(`Generation failed (${response.status}).`);
    }

    const payload = (await response.json()) as { url?: string };
    if (!payload.url) {
      throw new Error("The generation server returned no URL.");
    }
    return payload.url;
  }

  function playGeneratedAudio(url: string, label: string) {
    generatedAudioRef.current?.pause();
    const audio = new Audio(url);
    generatedAudioRef.current = audio;
    audio.addEventListener("ended", () => {
      if (generatedAudioRef.current === audio) {
        onPlayingAudioChange(null);
      }
    });
    onPlayingAudioChange({ label, url });
    void audio.play().catch(() => {
      // The browser may require another user gesture before playback; the generated URL remains available to the guide.
    });
  }

  async function lookAtScreen(): Promise<Record<string, unknown>> {
    if (activeVideoSource() === "camera") {
      return { looked: false, reason: "The camera is the active video source, so I cannot switch it to the screen." };
    }

    const screen = screenContainerRef.current;
    if (!screen) {
      return { looked: false, reason: "The main app screen is not ready yet." };
    }

    const width = screen.getBoundingClientRect().width;
    if (!width) {
      return { looked: false, reason: "The main app screen has no visible size." };
    }

    const canvas = await html2canvas(screen, {
      backgroundColor: "#0b101a",
      scale: Math.min(1, 640 / width),
      useCORS: true
    });
    const data = canvas.toDataURL("image/jpeg", 0.82).split(",")[1];
    if (!data || !sessionRef.current) {
      return { looked: false, reason: "The live session is not ready to receive the screen." };
    }

    sessionRef.current.sendRealtimeInput({ video: { data, mimeType: "image/jpeg" } });
    await new Promise<void>((resolve) => window.setTimeout(resolve, 800));
    return { looked: true };
  }

  const ACTIONS: Record<string, ActionDefinition> = {
    search_artwork: {
      description: "Search the public web for images of a specific artwork and show the matching pictures in the fixed artwork window.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "The artwork title, artist, or visual search phrase." } },
        required: ["query"],
        additionalProperties: false
      },
      run: async (parameters) => searchArtwork(String(parameters.query ?? ""))
    },
    clear_artwork: {
      description: "Close the fixed artwork window when the visitor no longer needs the images.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        onVisualPanelChange(null);
        return { cleared: true };
      }
    },
    look_at_screen: {
      description: "Look at the visible Vibe Museum screen only when the visitor asks about how the screen or its artwork window looks.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      run: lookAtScreen
    },
    generate_image: {
      description: "Generate a new gallery image from a creative prompt and show it in the fixed artwork window.",
      parameters: {
        type: "object",
        properties: { prompt: { type: "string", description: "A concise image-generation prompt." } },
        required: ["prompt"],
        additionalProperties: false
      },
      run: async (parameters) => {
        const prompt = String(parameters.prompt ?? "").trim();
        if (!prompt) return { error: "An image prompt is required." };
        const url = await requestGeneration("/api/image", { prompt });
        onVisualPanelChange({
          title: "Generated gallery image",
          subtitle: prompt,
          items: [{ title: "Generated image", imageUrl: url, sourceUrl: url }]
        });
        return { url };
      }
    },
    generate_sound_effect: {
      description: "Generate and play a short sound effect for the gallery.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "A concise sound-effect prompt." },
          duration_seconds: { type: "number", description: "Length in seconds, from 1 to 5." }
        },
        required: ["prompt", "duration_seconds"],
        additionalProperties: false
      },
      run: async (parameters) => {
        const prompt = String(parameters.prompt ?? "").trim();
        if (!prompt) return { error: "A sound-effect prompt is required." };
        const durationSeconds = Math.min(5, Math.max(1, Number(parameters.duration_seconds) || 1));
        const url = await requestGeneration("/api/sfx", { prompt, duration_seconds: durationSeconds });
        playGeneratedAudio(url, "Generated sound effect");
        return { url };
      }
    },
    generate_music: {
      description: "Generate and play an original music sketch inspired by a painting or creative brief.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "A concise music-generation prompt." },
          duration_seconds: { type: "number", description: "Length in seconds, from 5 to 20." }
        },
        required: ["prompt", "duration_seconds"],
        additionalProperties: false
      },
      run: async (parameters) => {
        const prompt = String(parameters.prompt ?? "").trim();
        if (!prompt) return { error: "A music prompt is required." };
        const durationSeconds = Math.min(20, Math.max(5, Number(parameters.duration_seconds) || 5));
        const url = await requestGeneration("/api/music", { prompt, duration_seconds: durationSeconds });
        playGeneratedAudio(url, "Generated music sketch");
        return { url };
      }
    }
  };

  async function handleToolCalls(functionCalls: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>) {
    for (const fc of functionCalls) {
      const action = fc.name ? ACTIONS[fc.name] : undefined;
      let result: Record<string, unknown>;
      if (!action) {
        result = { error: `Unknown app action: ${fc.name || "unnamed"}.` };
      } else {
        try {
          result = await action.run(fc.args ?? {});
        } catch (error) {
          result = { error: error instanceof Error ? error.message : "The app action failed." };
        }
      }

      sessionRef.current?.sendToolResponse({
        functionResponses: [{ id: fc.id, name: fc.name, response: result }]
      });
    }
  }

  function scheduleReconnect() {
    if (!shouldReconnectRef.current || reconnectTimerRef.current !== null) return;
    setConnectionStatus("Reconnectingâ€¦");
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      void connectLiveSession();
    }, 750);
  }

  async function connectLiveSession() {
    if (!shouldReconnectRef.current || isConnectingRef.current) return;
    isConnectingRef.current = true;
    setConnectionStatus("Connectingâ€¦");
    const connectionId = connectionIdRef.current + 1;
    connectionIdRef.current = connectionId;

    try {
      const token = await requestVoiceToken();
      const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: "v1alpha" } });
      const handle = resumptionHandleRef.current;
      const session = await ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
          inputAudioTranscription: {},
          sessionResumption: handle ? { handle } : {},
          systemInstruction: { parts: [{ text: systemPromptRef.current }] },
          tools: [{
            functionDeclarations: Object.entries(ACTIONS).map(([name, action]) => ({
              name,
              description: action.description,
              parametersJsonSchema: action.parameters
            }))
          }]
        },
        callbacks: {
          onmessage: (message) => {
            if (connectionId !== connectionIdRef.current) return;

            if (message.toolCall?.functionCalls) {
              modelReplyInProgressRef.current = true;
              void handleToolCalls(message.toolCall.functionCalls);
            }

            const update = message.sessionResumptionUpdate;
            if (update) {
              resumptionHandleRef.current = update.newHandle || undefined;
            }

            const content = message.serverContent;
            if (!content) return;
            if (content.interrupted) {
              clearQueuedPlayback();
              modelReplyInProgressRef.current = false;
              // The next microphone packet belongs to the interruption, so refresh silent context then.
              userTurnStatePushedRef.current = false;
            }

            if (content.modelTurn || content.outputTranscription) {
              modelReplyInProgressRef.current = true;
            }

            if (content.turnComplete) {
              modelReplyInProgressRef.current = false;
              userTurnStatePushedRef.current = false;
              if (statePushPendingRef.current) {
                statePushPendingRef.current = false;
                pushSilentState();
              }
            }

            appendTranscript("You", content.inputTranscription?.text);
            appendTranscript("Vibe Museum", content.outputTranscription?.text);
            for (const part of content.modelTurn?.parts ?? []) {
              if (part.inlineData?.data) {
                playAudioChunk(part.inlineData.data);
              }
            }
          },
          onerror: () => {
            if (connectionId === connectionIdRef.current) {
              setConnectionStatus("Connection hiccupâ€¦");
            }
          },
          onclose: () => {
            if (connectionId !== connectionIdRef.current) return;
            sessionRef.current = null;
            isConnectingRef.current = false;
            scheduleReconnect();
          }
        }
      });

      if (!shouldReconnectRef.current || connectionId !== connectionIdRef.current) {
        session.close();
        return;
      }

      sessionRef.current = session;
      isConnectingRef.current = false;
      setConnectionStatus("Live");
      pushSilentState();
      startCameraFrames();
    } catch (error) {
      isConnectingRef.current = false;
      if (connectionId === connectionIdRef.current) {
        setConnectionStatus(error instanceof Error ? error.message : "Could not connect to the live agent.");
        scheduleReconnect();
      }
    }
  }

  async function startMicrophoneCapture(
    stream: MediaStream,
    captureContext: AudioContext,
    resumeCapture: Promise<void>
  ) {
    await captureContext.audioWorklet.addModule("/pcm-capture-processor.js");
    if (captureContext.sampleRate !== CAPTURE_SAMPLE_RATE) {
      throw new Error("This browser cannot open a 16 kHz microphone audio context.");
    }

    const source = captureContext.createMediaStreamSource(stream);
    const captureNode = new AudioWorkletNode(captureContext, "pcm-capture-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1]
    });
    const silentGain = captureContext.createGain();
    silentGain.gain.value = 0;

    captureNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      const session = sessionRef.current;
      if (!session) return;
      if (!userTurnStatePushedRef.current) {
        pushSilentState();
        userTurnStatePushedRef.current = true;
      }
      session.sendRealtimeInput({
        audio: {
          data: arrayBufferToBase64(event.data),
          mimeType: "audio/pcm;rate=16000"
        }
      });
    };

    // Keeping the worklet in the graph makes the browser continue pulling audio frames.
    source.connect(captureNode);
    captureNode.connect(silentGain);
    silentGain.connect(captureContext.destination);
    captureNodeRef.current = captureNode;
    silentGainRef.current = silentGain;
    await resumeCapture;
  }

  async function startVoice() {
    if (isStarting || shouldReconnectRef.current) return;
    setIsStarting(true);
    setConnectionStatus("Preparing microphoneâ€¦");

    try {
      // Both contexts and their resume requests begin in this button handler.
      const captureContext = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });
      const playbackContext = new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
      captureContextRef.current = captureContext;
      playbackContextRef.current = playbackContext;
      if (captureContext.sampleRate !== CAPTURE_SAMPLE_RATE) {
        throw new Error("This browser cannot open a 16 kHz microphone audio context.");
      }
      if (playbackContext.sampleRate !== PLAYBACK_SAMPLE_RATE) {
        throw new Error("This browser cannot open a 24 kHz playback audio context.");
      }
      const resumeCapture = captureContext.resume();
      const resumePlayback = playbackContext.resume();
      const microphoneRequest = navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: CAPTURE_SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      const microphoneStream = await microphoneRequest;
      microphoneStreamRef.current = microphoneStream;
      await resumePlayback;
      await startMicrophoneCapture(microphoneStream, captureContext, resumeCapture);
      shouldReconnectRef.current = true;
      await connectLiveSession();
    } catch (error) {
      shouldReconnectRef.current = false;
      stopMicrophoneCapture();
      closePlaybackContext();
      setConnectionStatus(error instanceof Error ? error.message : "Microphone setup failed.");
    } finally {
      setIsStarting(false);
    }
  }

  function stopVoice() {
    shouldReconnectRef.current = false;
    connectionIdRef.current += 1;
    isConnectingRef.current = false;
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    sessionRef.current?.close();
    sessionRef.current = null;
    stopMicrophoneCapture();
    closePlaybackContext();
    setConnectionStatus("Offline");
  }

  async function toggleCamera() {
    if (cameraStreamRef.current) {
      stopCamera();
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false
      });
      cameraStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraEnabled(true);
      startCameraFrames();
    } catch (error) {
      setConnectionStatus(error instanceof Error ? error.message : "Camera setup failed.");
    }
  }

  function restartVoice() {
    if (!shouldReconnectRef.current) return;
    connectionIdRef.current += 1;
    sessionRef.current?.close();
    sessionRef.current = null;
    isConnectingRef.current = false;
    void connectLiveSession();
  }

  function sendTypedMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = typedMessage.trim();
    const session = sessionRef.current;
    if (!text || !session) return;

    pushSilentState();
    userTurnStatePushedRef.current = true;
    appendTranscript("You", text);
    session.sendClientContent({
      turns: [{ role: "user", parts: [{ text }] }],
      turnComplete: true
    });
    setTypedMessage("");
  }

  useEffect(() => {
    return () => {
      shouldReconnectRef.current = false;
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      if (statePushTimerRef.current !== null) window.clearTimeout(statePushTimerRef.current);
      sessionRef.current?.close();
      generatedAudioRef.current?.pause();
      stopMicrophoneCapture();
      closePlaybackContext();
      stopCamera();
    };
  }, []);

  const isLive = shouldReconnectRef.current;

  return (
    <section className="voice-agent" aria-label="Live voice agent">
      <div className="voice-heading">
        <div>
          <p className="eyebrow">Gemini Live</p>
          <h2>Gallery conversation</h2>
        </div>
        <span className={`connection-status ${isLive ? "is-live" : ""}`}>{connectionStatus}</span>
      </div>

      <div className="guide-editor">
        <button
          className="guide-editor-toggle"
          type="button"
          onClick={() => setIsGuideEditorOpen((open) => !open)}
          aria-expanded={isGuideEditorOpen}
          aria-controls="system-prompt"
        >
          {isGuideEditorOpen ? "Hide guide settings" : "Customize guide"}
        </button>
        {isGuideEditorOpen && (
          <div className="guide-editor-content">
            <label className="field-label" htmlFor="system-prompt">Gallery guide personality</label>
            <textarea
              id="system-prompt"
              className="prompt-input"
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
            />
            <p className="field-note">Changes take effect when you start or restart the voice session.</p>
          </div>
        )}
      </div>

      <div className="voice-actions">
        {isLive ? (
          <>
            <button className="button secondary" type="button" onClick={restartVoice}>Restart with this personality</button>
            <button className="button danger" type="button" onClick={stopVoice}>End voice session</button>
          </>
        ) : (
          <button className="button primary" type="button" onClick={() => void startVoice()} disabled={isStarting}>
            {isStarting ? "Startingâ€¦" : "Start voice conversation"}
          </button>
        )}
        <button className="button secondary" type="button" onClick={() => void toggleCamera()}>
          {cameraEnabled ? "Turn camera off" : "Turn camera on"}
        </button>
      </div>

      <video ref={videoRef} className={`camera-preview ${cameraEnabled ? "visible" : ""}`} muted playsInline />

      <div className="transcript" aria-live="polite">
        {transcripts.length ? transcripts.map((line) => (
          <article className={`transcript-line ${line.role === "You" ? "user" : "agent"}`} key={line.id}>
            <span>{line.role}</span>
            <p>{line.text}</p>
          </article>
        )) : <p className="empty-transcript">Start the session, then speak about the painting in front of you.</p>}
      </div>

      <form className="text-composer" onSubmit={sendTypedMessage}>
        <label className="field-label" htmlFor="typed-message">Or write to the guide</label>
        <div className="text-composer-row">
          <input
            id="typed-message"
            value={typedMessage}
            onChange={(event) => setTypedMessage(event.target.value)}
            placeholder="Ask about an artwork, or ask the guide to make somethingâ€¦"
            disabled={!isLive}
          />
          <button className="button primary" type="submit" disabled={!isLive || !typedMessage.trim()}>Send</button>
        </div>
      </form>
    </section>
  );
}


import { useRef, useState } from "react";
import { LiveVoiceAgent } from "./LiveVoiceAgent";
import type { PlayingAudio, VisualPanel } from "./types";

export default function App() {
  const mainAppRef = useRef<HTMLDivElement>(null);
  const [visualPanel, setVisualPanel] = useState<VisualPanel | null>(null);
  const [playingAudio, setPlayingAudio] = useState<PlayingAudio | null>(null);

  return (
    <main className="page-shell">
      <div className="main-app" ref={mainAppRef}>
        <section className="intro">
          <p className="eyebrow">Standalone prototype</p>
          <h1>Vibe Museum Voice Lab</h1>
          <p>
            A live gallery companion for talking through a paintingâ€™s mood, the music it could become, and the creative brief behind it.
          </p>
        </section>

        {playingAudio && (
          <aside className="now-playing" aria-live="polite">
            <span>Now playing</span>
            <strong>{playingAudio.label}</strong>
          </aside>
        )}

        {visualPanel && (
          <aside className="artwork-window" aria-label={visualPanel.title}>
            <div className="artwork-window-heading">
              <div>
                <p className="eyebrow">Artwork finder</p>
                <h2>{visualPanel.title}</h2>
                <p>{visualPanel.subtitle}</p>
              </div>
              <button type="button" className="close-button" onClick={() => setVisualPanel(null)} aria-label="Close artwork window">Ã—</button>
            </div>
            <div className="artwork-grid">
              {visualPanel.items.map((item) => (
                <a key={`${item.title}-${item.imageUrl}`} href={item.sourceUrl || item.imageUrl} target="_blank" rel="noreferrer">
                  <img src={item.imageUrl} alt={item.title} />
                  <span>{item.title}</span>
                </a>
              ))}
            </div>
          </aside>
        )}
      </div>

      <LiveVoiceAgent
        screenContainerRef={mainAppRef}
        visualPanel={visualPanel}
        playingAudio={playingAudio}
        onVisualPanelChange={setVisualPanel}
        onPlayingAudioChange={setPlayingAudio}
      />
    </main>
  );
}


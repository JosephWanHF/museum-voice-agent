# Vibe Museum Voice Lab

Standalone Gemini Live API test surface for the Vibe Museum gallery companion. It is intentionally isolated from every existing app in this workspace.

## Run it

```powershell
cd voice-agent-lab
npm install
Copy-Item .env.example .env
npm run dev
```

Set `VITE_WORKSHOP_API_KEY` in `.env` with your workshop-server key. The `.env` file is intentionally ignored by Git and is never included in the repository.

Click **Start voice conversation** to grant microphone access and open the session. The browser sends 16 kHz, mono, 16-bit PCM in roughly 100 ms chunks; model audio is scheduled on a separate 24 kHz context. Camera frames are optional and are sent as JPEGs every five seconds while the camera is on.

The short-lived Gemini credential is requested at connection time from the workshop token service. No API credential is stored in the code.


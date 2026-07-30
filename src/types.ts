export interface VisualResult {
  title: string;
  imageUrl: string;
  sourceUrl?: string;
}

export interface VisualPanel {
  title: string;
  subtitle: string;
  items: VisualResult[];
}

export interface PlayingAudio {
  label: string;
  url: string;
}


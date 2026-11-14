// The browser's built-in speech recognition isn't in TypeScript's standard DOM types yet.
interface SpeechRecognitionAlternative { transcript: string; confidence: number }
interface SpeechRecognitionResult { readonly length: number; readonly isFinal: boolean; [index: number]: SpeechRecognitionAlternative }
interface SpeechRecognitionResultList { readonly length: number; [index: number]: SpeechRecognitionResult }
interface SpeechRecognitionEvent extends Event { readonly results: SpeechRecognitionResultList }
interface SpeechRecognitionErrorEvent extends Event { readonly error: string }
interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
interface Window {
  SpeechRecognition?: new () => SpeechRecognition;
  webkitSpeechRecognition?: new () => SpeechRecognition;
  webkitAudioContext?: typeof AudioContext;
}

// @novnc/novnc ships no type declarations (pure JS, "exports": "./core/rfb.js").
// Minimal surface covering only what ConnectViewer.tsx actually uses —
// not a full port of the library's API.
declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: {
      shared?: boolean;
      credentials?: { username?: string; password?: string; target?: string };
      repeaterID?: string;
      wsProtocols?: string[];
    });
    scaleViewport: boolean;
    resizeSession: boolean;
    viewOnly: boolean;
    disconnect(): void;
  }
}

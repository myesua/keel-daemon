// Voice input built for reliability. The Web Speech API drops sessions in the
// wild (network hiccups, silence timeouts, service restarts), so this wrapper
// treats every stop as recoverable: it restarts automatically while the user
// still wants to talk, keeps a watchdog against silent stalls, and always
// preserves the transcript gathered so far.

export class VoiceInput {
  constructor({ onPartial, onFinal, onState, onError }) {
    this.onPartial = onPartial || (() => {});
    this.onFinal = onFinal || (() => {});
    this.onState = onState || (() => {});
    this.onError = onError || (() => {});
    this.recognition = null;
    this.wantListening = false;
    this.restartDelayMs = 250;
    this.watchdogTimer = null;
    this.lastActivityAt = 0;
    this.finalBuffer = "";
  }

  static isSupported() {
    return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  start() {
    if (!VoiceInput.isSupported()) {
      this.onError("Voice input is not available in this browser.");
      return false;
    }
    this.wantListening = true;
    this.finalBuffer = "";
    this.restartDelayMs = 250;
    this._spin();
    this._armWatchdog();
    this.onState("listening");
    return true;
  }

  stop() {
    this.wantListening = false;
    clearTimeout(this.watchdogTimer);
    if (this.recognition) {
      try { this.recognition.stop(); } catch (_) {}
    }
    this.onState("idle");
    const text = this.finalBuffer.trim();
    this.finalBuffer = "";
    if (text) this.onFinal(text);
  }

  _spin() {
    if (!this.wantListening) return;
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new Recognition();
    this.recognition = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    this.lastActivityAt = Date.now();

    recognition.onresult = (event) => {
      this.lastActivityAt = Date.now();
      this.restartDelayMs = 250;
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) {
          this.finalBuffer += `${result[0].transcript} `;
        } else {
          interim += result[0].transcript;
        }
      }
      this.onPartial((this.finalBuffer + interim).trim());
    };

    recognition.onerror = (event) => {
      this.lastActivityAt = Date.now();
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        this.wantListening = false;
        this.onState("idle");
        this.onError("Chrome blocked the microphone. Allow microphone access for Keel and try again.");
        return;
      }
      // no-speech, network, aborted, audio-capture: all recoverable, restart below.
    };

    recognition.onend = () => {
      if (!this.wantListening) return;
      // The service ended on its own. Restart with a small backoff so a flaky
      // network cannot spin us; the transcript buffer is untouched.
      setTimeout(() => this._spin(), this.restartDelayMs);
      this.restartDelayMs = Math.min(this.restartDelayMs * 2, 4000);
    };

    try {
      recognition.start();
    } catch (_) {
      // start() throws if called while another instance winds down; retry.
      setTimeout(() => this._spin(), 350);
    }
  }

  _armWatchdog() {
    clearTimeout(this.watchdogTimer);
    const check = () => {
      if (!this.wantListening) return;
      if (Date.now() - this.lastActivityAt > 15000) {
        // Stalled without an end event. Force a clean restart.
        try { this.recognition?.abort(); } catch (_) {}
        this.lastActivityAt = Date.now();
      }
      this.watchdogTimer = setTimeout(check, 5000);
    };
    this.watchdogTimer = setTimeout(check, 5000);
  }
}

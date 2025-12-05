// speaking-localstorage.js
// Este arquivo roda NO NAVEGADOR.
// Ele intercepta chamadas para /api/speaking
// e salva o áudio TTS no localStorage, por id da tentativa.

(function () {
  if (typeof window === "undefined" || typeof window.fetch === "undefined") {
    // segurança: só roda no browser
    return;
  }

  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const [input, init] = args;
    const url = typeof input === "string" ? input : input.url;

    // chama o fetch original
    const response = await originalFetch(...args);

    // só vamos mexer se for /api/speaking
    try {
      if (url.includes("/api/speaking")) {
        // clona a resposta para poder ler o JSON
        const clone = response.clone();
        const data = await clone.json();

        // se a API mandou id + audioBase64, salvamos no localStorage
        if (data && data.id && data.audioBase64) {
          const key = "speaking_tts_by_id";

          // carrega o que já temos
          let store = {};
          try {
            store = JSON.parse(localStorage.getItem(key) || "{}");
          } catch {
            store = {};
          }

          // guarda o áudio TTS dessa tentativa
          store[data.id] = data.audioBase64;

          // salva de volta
          localStorage.setItem(key, JSON.stringify(store));
          // se quiser, também pode salvar transcript, etc.
        }
      }
    } catch (e) {
      console.warn("Erro ao salvar speaking no localStorage:", e);
    }

    // devolve a resposta normal para o resto do código
    return response;
  };
})();

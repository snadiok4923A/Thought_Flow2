# ThoughtFlow2 (SmartNote)

Mind-map note app — React + Vite frontend, gh-pages hosted at
[snadiok4923a.github.io/Thought_Flow2](https://snadiok4923a.github.io/Thought_Flow2/).

**AI Chat Capture** turns Q+A pairs from AI chat sites (ChatGPT, Gemini, Arena and
more) into mind-map nodes automatically — see **[AI_CAPTURE.md](AI_CAPTURE.md)**.

## Develop

```bash
npm install
npm run dev        # frontend → http://localhost:5173/Thought_Flow2/
cd server && npm install && npm start   # capture API → http://localhost:5001
```

## Deploy

`npm run deploy` builds and publishes to the `gh-pages` branch. The capture
backend is hosted separately (see AI_CAPTURE.md → "Hosting the capture API");
the frontend reads `VITE_CAPTURE_API_BASE` / `VITE_CAPTURE_TOKEN` at build time,
or you can change the API base at runtime in the panel's ⚙ Settings.

---

# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is enabled on this template. See [this documentation](https://react.dev/learn/react-compiler) for more information.

Note: This will impact Vite dev & build performances.

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        ink:    "#002776",   // azul Brasil — tinta
        ink2:   "#1a3a72",
        green:  "#009739",   // verde Brasil — primário
        green2: "#00b545",
        yellow: "#FFDF00",   // amarelo Brasil — destaque
        paper:  "#ffffff",
        paper2: "#f5f7fa",
        paper3: "#e7ecf3",
        rule:   "#d2dae5",
        rule2:  "#b6c1d2",
        soft:   "#5a6a85",
        mute:   "#8092ab",
      },
      fontFamily: {
        anton:   ["Anton", "Arial Black", "sans-serif"],
        sans:    ["Inter", "system-ui", "sans-serif"],
        serif:   ["Fraunces", "Georgia", "serif"],
        mono:    ["JetBrains Mono", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;

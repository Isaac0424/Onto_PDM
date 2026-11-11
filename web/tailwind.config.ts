import type { Config } from "tailwindcss";

// K-PLM 디자인 토큰 (kplm-frontend/assets/js/tailwind.config.js 를 Vite 빌드용으로 옮김)
const INTER = ["Inter", "Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", "sans-serif"];
const MONO = ["JetBrains Mono", "D2Coding", "ui-monospace", "Menlo", "monospace"];

const config: Config = {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        "surface-container-high": "#dce9ff", "on-error-container": "#93000a", "secondary-fixed": "#dce1ff",
        "secondary-container": "#8fa7fe", "tertiary-fixed-dim": "#68dba9", "error": "#ba1a1a",
        "background": "#f8f9ff", "primary-container": "#2563eb", "surface-dim": "#cbdbf5",
        "surface-container-lowest": "#ffffff", "surface-bright": "#f8f9ff", "error-container": "#ffdad6",
        "surface-container-highest": "#d3e4fe", "status-proc-soft": "#EFF6FF", "on-background": "#0b1c30",
        "on-tertiary-fixed-variant": "#005137", "status-ok": "#059669", "on-tertiary-fixed": "#002114",
        "secondary-fixed-dim": "#b6c4ff", "on-secondary-container": "#1d3989", "primary": "#004ac6",
        "on-surface": "#0b1c30", "on-primary-container": "#eeefff", "on-secondary": "#ffffff",
        "slate-paper": "#FFFFFF", "tertiary-fixed": "#85f8c4", "surface-tint": "#0053db",
        "doc-highlight": "#FEF08A", "outline-variant": "#c3c6d7", "outline": "#737686",
        "slate-sunk": "#F1F5F9", "surface-container-low": "#eff4ff", "slate-line": "#CBD5E1",
        "inverse-surface": "#213145", "primary-fixed": "#dbe1ff", "status-ok-soft": "#ECFDF5",
        "primary-fixed-dim": "#b4c5ff", "on-primary-fixed-variant": "#003ea8", "tertiary": "#006243",
        "slate-ink": "#0F172A", "on-primary": "#ffffff", "status-review-soft": "#FEF3C7",
        "surface-variant": "#d3e4fe", "on-primary-fixed": "#00174b", "on-surface-variant": "#434655",
        "on-tertiary": "#ffffff", "status-proc": "#2563EB", "secondary": "#4059aa",
        "on-secondary-fixed-variant": "#264191", "inverse-primary": "#b4c5ff", "surface-container": "#e5eeff",
        "status-review": "#D97706", "slate-bg": "#F8FAFC", "on-secondary-fixed": "#00164e",
        "inverse-on-surface": "#eaf1ff", "status-err-soft": "#FEE2E2", "on-error": "#ffffff",
        "status-err": "#DC2626", "surface": "#f8f9ff", "on-tertiary-container": "#bdffdc",
        "tertiary-container": "#007d57",
        // 글래스 셸(블루 틴트 바탕 + 유리 사이드바·머리 + 불투명 패널). web/docs/DESIGN.md "Glass Shell"
        "page": "#e7ecf8", "glass": "rgba(255, 255, 255, 0.5)", "glass-edge": "rgba(255, 255, 255, 0.95)", "panel-head": "#f4f6fb",
        "group-row": "rgba(245, 158, 11, 0.07)"
      },
      boxShadow: {
        glass: "inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 1px 2px rgba(30, 58, 138, 0.05), 0 8px 28px rgba(30, 58, 138, 0.08)",
        float: "inset 0 1px 0 rgba(255, 255, 255, 0.95), 0 2px 6px rgba(30, 58, 138, 0.06), 0 18px 48px rgba(30, 58, 138, 0.16)",
        hl: "inset 0 1px 0 rgba(255, 255, 255, 0.9)",
        "btn-primary": "0 4px 14px rgba(37, 99, 235, 0.25)",
        seg: "0 1px 3px rgba(30, 58, 138, 0.12)",
        fab: "inset 0 1px 0 rgba(255, 255, 255, 0.35), 0 8px 24px rgba(37, 99, 235, 0.35)"
      },
      borderRadius: { DEFAULT: "0.125rem", lg: "0.25rem", xl: "0.5rem", full: "0.75rem", panel: "14px", glass: "18px", seg: "10px", "seg-item": "7px" },
      spacing: {
        "space-md": "0.75rem", "gutter": "1rem", "space-sm": "0.5rem", "space-xl": "1.5rem",
        "margin-mobile": "1rem", "space-xs": "0.25rem", "margin": "1.5rem", "space-lg": "1rem",
        "gutter-dense": "0.5rem"
      },
      fontFamily: {
        "body-lg": INTER, "headline-md": INTER, "label-md": MONO,
        "headline-lg": INTER, "body-sm": INTER, "tabular-data": MONO,
        "body-md-bold": INTER, "body-md": INTER, "headline-sm": INTER, "label-sm": MONO
      },
      fontSize: {
        "body-lg": ["15px", { lineHeight: "22px", fontWeight: "400" }],
        "headline-md": ["18px", { lineHeight: "24px", letterSpacing: "-0.01em", fontWeight: "700" }],
        "label-md": ["12px", { lineHeight: "16px", letterSpacing: "0.02em", fontWeight: "500" }],
        "headline-lg": ["24px", { lineHeight: "32px", letterSpacing: "-0.015em", fontWeight: "700" }],
        "body-sm": ["12px", { lineHeight: "16px", fontWeight: "400" }],
        "tabular-data": ["12px", { lineHeight: "16px", fontWeight: "400" }],
        "body-md-bold": ["13px", { lineHeight: "18px", fontWeight: "600" }],
        "body-md": ["13px", { lineHeight: "18px", fontWeight: "400" }],
        "headline-sm": ["16px", { lineHeight: "22px", letterSpacing: "-0.005em", fontWeight: "600" }],
        "label-sm": ["11px", { lineHeight: "14px", letterSpacing: "0.04em", fontWeight: "400" }]
      }
    }
  }
};

export default config;

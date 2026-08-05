/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Inter",
          "Roboto",
          "Helvetica Neue",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "ui-monospace",
          "Menlo",
          "monospace",
        ],
      },
      // ─── type scale ────────────────────────────────────────────────────
      // The UI previously mixed twelve arbitrary sizes chosen per component
      // (10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 15, 26, 36px), so two
      // labels doing the same job in different cards rendered at different
      // sizes and nothing lined up. These seven semantic steps replace them;
      // `text-[Npx]` in a component is now a smell, not the norm.
      fontSize: {
        display: ["28px", { lineHeight: "1.1", letterSpacing: "-0.022em" }],
        stat: ["24px", { lineHeight: "1.1", letterSpacing: "-0.015em" }],
        title: ["14px", { lineHeight: "1.35", letterSpacing: "-0.006em" }],
        body: ["13px", { lineHeight: "1.55" }],
        meta: ["12px", { lineHeight: "1.45" }],
        micro: ["11px", { lineHeight: "1.4" }],
        // Uppercase eyebrow labels ONLY — the tracking is baked in, which is
        // right for capitals and wrong for everything else. Lowercase text
        // that used to sit at 10px now uses `micro` (11px) instead: it is the
        // smallest type in the product and 10px was below where it needed to
        // be, so there is no lowercase step under `micro` on purpose.
        label: ["10.5px", { lineHeight: "1.3", letterSpacing: "0.09em" }],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // able ink shades (matched to inkDim / inkMuted / inkFaint)
        ink: {
          DEFAULT: "hsl(var(--foreground))",
          dim: "hsl(var(--muted-foreground))",
          muted: "hsl(var(--ink-muted))",
          faint: "hsl(var(--ink-faint))",
        },
        // data-scale colors
        clean: "hsl(var(--clean))",
        medium: "hsl(var(--medium))",
        dirty: "hsl(var(--dirty))",
        up: "hsl(var(--up))",
        down: "hsl(var(--down))",
        // Energy-mix legacy colors (kept — used by existing charts)
        solar: "#FCD34D",
        wind: {
          onshore: "#60A5FA",
          offshore: "#3B82F6",
        },
        hydro: "#2DD4BF",
        biomass: "#22C55E",
        geothermal: "#F97316",
        price: {
          low: "#22C55E",
          medium: "#F59E0B",
          high: "#EF4444",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "pulse-subtle": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.7" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in": "fade-in 0.3s ease-out",
        "slide-up": "slide-up 0.4s ease-out",
        "pulse-subtle": "pulse-subtle 2s ease-in-out infinite",
        shimmer: "shimmer 2s infinite linear",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}

// src/lib/utils/themeColor.ts

import type React from 'react';

export interface NetworkThemeColor {
  readonly id: string;
  readonly name: string;
  readonly hex: string;
}

/**
 * Paleta oficial do Hiperverso:
 * 12 cores cósmicas, vibrantes e de alto contraste (WCAG AA).
 * Balanceadas para visibilidade cristalina contra fundos escuros/pretos e claros.
 * Proibido preto, branco e cinzas opacos.
 */
export const OFFICIAL_NETWORK_PALETTE: readonly NetworkThemeColor[] = [
  { id: 'cosmic-blue', name: 'Azul Cósmico', hex: '#2563eb' },
  { id: 'scarlet-nova', name: 'Fogo Escarlate', hex: '#dc2626' },
  { id: 'aurora-emerald', name: 'Aurora Esmeralda', hex: '#059669' },
  { id: 'supernova-indigo', name: 'Supernova Índigo', hex: '#6366f1' },
  { id: 'solar-amber', name: 'Solar Âmbar', hex: '#d97706' },
  { id: 'cosmic-orchid', name: 'Orquídea Cósmica', hex: '#a855f7' },
  { id: 'quantum-magenta', name: 'Magenta Quântico', hex: '#c026d3' },
  { id: 'pulsar-ruby', name: 'Rubi Pulsar', hex: '#e11d48' },
  { id: 'oceanic-teal', name: 'Turquesa Oceânica', hex: '#0d9488' },
  { id: 'quasar-violet', name: 'Quasar Violeta', hex: '#8b5cf6' },
  { id: 'cosmic-coral', name: 'Coral Cósmico', hex: '#ea580c' },
  { id: 'nebula-cyan', name: 'Nebulosa Ciano', hex: '#0891b2' },
] as const;

export const OFFICIAL_ROTATION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutos

/**
 * Calcula a cor oficial dinâmica da rede para o bloco de 5 minutos atual (ou especificado).
 * Determinístico e universal: sincronizado entre abas e visitantes do mundo inteiro nos marcos :00, :05, :10...
 */
export function getOfficialDynamicColor(timestampMs: number = Date.now()): NetworkThemeColor {
  const slot = Math.floor(timestampMs / OFFICIAL_ROTATION_INTERVAL_MS);
  const day = Math.floor(timestampMs / 86_400_000);
  // O passo 7 é coprimo de 12 (comprimento da paleta): garante salto entre matizes distintos
  // sem repetir a cor imediatamente anterior. O offset diário traz variação orgânica contínua.
  const index = Math.abs((slot * 7 + day) % OFFICIAL_NETWORK_PALETTE.length);
  return OFFICIAL_NETWORK_PALETTE[index];
}

/**
 * Retorna a cor de destaque efetiva:
 * - Se o usuário tem cor personalizada válida (`userAccentColor`), ela é preservada intacta.
 * - Se for visitante ou não tiver cor customizada, retorna a cor oficial de 5 min do Hiperverso.
 */
export function getEffectiveAccentColor(userAccentColor?: string | null, timestampMs: number = Date.now()): string {
  if (isValidHexColor(userAccentColor)) {
    return userAccentColor;
  }
  return getOfficialDynamicColor(timestampMs).hex;
}

export const PROFILE_ACCENT_PRESETS: { name: string; hex: string }[] = [
  { name: 'Azul padrão', hex: '#2563eb' },
  { name: 'Vermelho', hex: '#dc2626' },
  { name: 'Verde', hex: '#16a34a' },
  { name: 'Roxo', hex: '#9333ea' },
  { name: 'Rosa', hex: '#db2777' },
  { name: 'Laranja', hex: '#ea580c' },
  { name: 'Ciano', hex: '#0891b2' },
  { name: 'Dourado', hex: '#ca8a04' },
];

export function isValidHexColor(hex?: string | null): hex is string {
  return typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  if (!isValidHexColor(hex)) return null;
  const clean = hex.slice(1);
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

interface HslTriplet {
  h: number;
  s: number;
  l: number;
}

function hexToHslValues(hex: string): HslTriplet | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;

  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  let h = 0;
  let s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }

  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}

export function hexToHslComponents(hex: string): string | null {
  const hsl = hexToHslValues(hex);
  if (!hsl) return null;
  return `${hsl.h} ${hsl.s}% ${hsl.l}%`;
}

function parseHslTriplet(value: string): HslTriplet | null {
  const match = value.match(/^\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%\s*$/);
  if (!match) return null;
  return {
    h: Number(match[1]),
    s: Number(match[2]),
    l: Number(match[3]),
  };
}

function formatHslTriplet(hsl: HslTriplet): string {
  return `${Math.round(hsl.h)} ${Math.round(hsl.s)}% ${Math.round(hsl.l)}%`;
}

export function getContrastForegroundHsl(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return '0 0% 98%';
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luminance > 0.62 ? '0 0% 9%' : '0 0% 98%';
}

// Mesmo formato dos tons calculados (`H S% L%`, separados por ESPAÇO): com vírgulas, `hsl(var(--primary) / 0.25)` (usado em
// `bg-primary/25`, `ring-primary/30`...) é CSS inválido e o realce some.
const DEFAULT_ACCENT_STYLE: React.CSSProperties = {
  '--primary': '228 90% 55%',
  '--primary-foreground': '9 21% 86%',
  '--accent': '228 90% 55%',
  '--accent-foreground': '9 21% 86%',
  '--ring': '228 90% 55%',
  '--sidebar-primary': '228 90% 55%',
  '--sidebar-primary-foreground': '9 21% 86%',
  '--sidebar-accent': '228 90% 55%',
  '--sidebar-accent-foreground': '9 21% 86%',
  '--sidebar-ring': '228 90% 55%',
} as React.CSSProperties;

/** O tema de alto contraste (next-themes): acessibilidade vem ANTES da cor de gosto. */
export const HIGH_CONTRAST_THEME = 'high-contrast';

/** O documento está no alto contraste? (leitura direta da classe do <html>: sem assinar o tema em cada cartão do feed) */
export function isHighContrastDocument(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains(HIGH_CONTRAST_THEME);
}

export function getProfileAccentStyle(
  accentColor?: string | null,
  options?: { fallbackToDefault?: boolean; highContrast?: boolean }
): React.CSSProperties | undefined {
  if (options?.highContrast) return undefined;
  if (!isValidHexColor(accentColor)) {
    return options?.fallbackToDefault ? DEFAULT_ACCENT_STYLE : undefined;
  }
  const hsl = hexToHslComponents(accentColor);
  if (!hsl) {
    return options?.fallbackToDefault ? DEFAULT_ACCENT_STYLE : undefined;
  }
  const fg = getContrastForegroundHsl(accentColor);
  return {
    '--primary': hsl,
    '--primary-foreground': fg,
    '--accent': hsl,
    '--accent-foreground': fg,
    '--ring': hsl,
    '--sidebar-primary': hsl,
    '--sidebar-primary-foreground': fg,
    '--sidebar-accent': hsl,
    '--sidebar-accent-foreground': fg,
    '--sidebar-ring': hsl,
  } as React.CSSProperties;
}

const ACCENT_CSS_VARS = [
  '--primary',
  '--primary-foreground',
  '--accent',
  '--accent-foreground',
  '--ring',
  '--sidebar-primary',
  '--sidebar-primary-foreground',
  '--sidebar-accent',
  '--sidebar-accent-foreground',
  '--sidebar-ring',
] as const;

export function applyDocumentAccentColor(
  accentColor?: string | null,
  options?: { highContrast?: boolean; fallbackToDynamicOfficial?: boolean }
): void {
  if (typeof document === 'undefined') return;
  const rootStyle = document.documentElement.style;

  if (options?.highContrast) {
    for (const key of ACCENT_CSS_VARS) {
      rootStyle.removeProperty(key);
    }
    return;
  }

  const targetColor = isValidHexColor(accentColor)
    ? accentColor
    : (options?.fallbackToDynamicOfficial ? getOfficialDynamicColor().hex : null);

  const vars = targetColor ? getProfileAccentStyle(targetColor) : undefined;
  if (!vars) {
    for (const key of ACCENT_CSS_VARS) {
      rootStyle.removeProperty(key);
    }
    return;
  }

  const record = vars as Record<string, string>;
  for (const key of ACCENT_CSS_VARS) {
    if (record[key]) {
      rootStyle.setProperty(key, record[key]);
    }
  }
}

let activeAccentAnimationFrame: number | null = null;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Aplica a cor de destaque no documento com interpolação suave em HSL,
 * evitando saltos bruscos nas trocas de paleta oficial ou cor de perfil.
 */
export function transitionDocumentAccentColor(
  accentColor?: string | null,
  options?: { highContrast?: boolean; fallbackToDynamicOfficial?: boolean; durationMs?: number }
): () => void {
  if (activeAccentAnimationFrame !== null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(activeAccentAnimationFrame);
    activeAccentAnimationFrame = null;
  }

  if (
    typeof document === 'undefined' ||
    typeof window === 'undefined' ||
    options?.highContrast ||
    typeof window.requestAnimationFrame !== 'function' ||
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  ) {
    applyDocumentAccentColor(accentColor, options);
    return () => {};
  }

  const targetColor = isValidHexColor(accentColor)
    ? accentColor
    : (options?.fallbackToDynamicOfficial ? getOfficialDynamicColor().hex : null);

  if (!targetColor) {
    applyDocumentAccentColor(null, options);
    return () => {};
  }

  const root = document.documentElement;
  const rootStyle = root.style;
  const rawCurrent =
    rootStyle.getPropertyValue('--primary') || getComputedStyle(root).getPropertyValue('--primary');
  const start = parseHslTriplet(rawCurrent);
  const target = hexToHslValues(targetColor);

  if (
    !start ||
    !target ||
    (Math.abs(start.h - target.h) < 0.5 &&
      Math.abs(start.s - target.s) < 0.5 &&
      Math.abs(start.l - target.l) < 0.5)
  ) {
    applyDocumentAccentColor(targetColor, options);
    return () => {};
  }

  const rawCurrentFg =
    rootStyle.getPropertyValue('--primary-foreground') ||
    getComputedStyle(root).getPropertyValue('--primary-foreground');
  const startFg = parseHslTriplet(rawCurrentFg);
  const targetFgStr = getContrastForegroundHsl(targetColor);
  const targetFg = parseHslTriplet(targetFgStr);

  const durationMs = Math.max(80, options?.durationMs ?? 600);
  const startTime = performance.now();
  let cancelled = false;

  const dh = ((target.h - start.h + 540) % 360) - 180;
  const ds = target.s - start.s;
  const dl = target.l - start.l;

  const ACCENT_COLOR_KEYS = [
    '--primary',
    '--accent',
    '--ring',
    '--sidebar-primary',
    '--sidebar-accent',
    '--sidebar-ring',
  ] as const;

  const ACCENT_FG_KEYS = [
    '--primary-foreground',
    '--accent-foreground',
    '--sidebar-primary-foreground',
    '--sidebar-accent-foreground',
  ] as const;

  const step = (now: number) => {
    if (cancelled) return;
    const rawProgress = Math.min(1, (now - startTime) / durationMs);
    if (rawProgress >= 1) {
      activeAccentAnimationFrame = null;
      applyDocumentAccentColor(targetColor, options);
      return;
    }

    const eased = easeInOutCubic(rawProgress);
    const interpolated = formatHslTriplet({
      h: (start.h + dh * eased + 360) % 360,
      s: start.s + ds * eased,
      l: start.l + dl * eased,
    });

    for (const key of ACCENT_COLOR_KEYS) {
      rootStyle.setProperty(key, interpolated);
    }

    const fgValue =
      startFg && targetFg
        ? formatHslTriplet({
            h: startFg.h + (targetFg.h - startFg.h) * eased,
            s: startFg.s + (targetFg.s - startFg.s) * eased,
            l: startFg.l + (targetFg.l - startFg.l) * eased,
          })
        : eased >= 0.5
          ? targetFgStr
          : rawCurrentFg.trim() || targetFgStr;

    for (const key of ACCENT_FG_KEYS) {
      rootStyle.setProperty(key, fgValue);
    }

    activeAccentAnimationFrame = window.requestAnimationFrame(step);
  };

  activeAccentAnimationFrame = window.requestAnimationFrame(step);

  return () => {
    cancelled = true;
    if (activeAccentAnimationFrame !== null) {
      window.cancelAnimationFrame(activeAccentAnimationFrame);
      activeAccentAnimationFrame = null;
    }
  };
}

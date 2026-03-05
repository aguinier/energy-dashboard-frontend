import { format, formatDistanceToNow, parseISO } from 'date-fns';

export function formatNumber(value: number | null | undefined, options?: {
  decimals?: number;
  suffix?: string;
  compact?: boolean;
}): string {
  if (value === null || value === undefined) return '-';

  const { decimals = 0, suffix = '', compact = false } = options || {};

  if (compact && Math.abs(value) >= 1000) {
    const units = ['', 'K', 'M', 'B', 'T'];
    let unitIndex = 0;
    let scaledValue = value;

    while (Math.abs(scaledValue) >= 1000 && unitIndex < units.length - 1) {
      scaledValue /= 1000;
      unitIndex++;
    }

    return `${scaledValue.toFixed(1)}${units[unitIndex]}${suffix}`;
  }

  return `${value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}${suffix}`;
}

export function formatMW(value: number | null | undefined): string {
  return formatNumber(value, { decimals: 0, suffix: ' MW', compact: true });
}

export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return `${value.toFixed(2)} EUR/MWh`;
}

export function formatPercentage(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return `${value.toFixed(1)}%`;
}

export function formatDate(dateString: string | null | undefined, formatStr: string = 'MMM d, yyyy'): string {
  if (!dateString) return '-';
  try {
    return format(parseISO(dateString), formatStr);
  } catch {
    return dateString;
  }
}

export function formatDateTime(dateString: string | null | undefined): string {
  return formatDate(dateString, 'MMM d, yyyy HH:mm');
}

export function formatTimeAgo(dateString: string | null | undefined): string {
  if (!dateString) return '-';
  try {
    return formatDistanceToNow(parseISO(dateString), { addSuffix: true });
  } catch {
    return dateString;
  }
}

export function formatChange(value: number | null | undefined): {
  text: string;
  isPositive: boolean;
  isNegative: boolean;
} {
  if (value === null || value === undefined) {
    return { text: '-', isPositive: false, isNegative: false };
  }

  const isPositive = value > 0;
  const isNegative = value < 0;
  const arrow = isPositive ? '↑' : isNegative ? '↓' : '';
  const text = `${arrow} ${Math.abs(value).toFixed(2)}`;

  return { text, isPositive, isNegative };
}

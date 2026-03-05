import { useEffect, useState, useRef } from 'react';

interface UseAnimatedValueOptions {
  duration?: number;
  decimals?: number;
  delay?: number;
}

export function useAnimatedValue(
  targetValue: number | null | undefined,
  options: UseAnimatedValueOptions = {}
): number {
  const { duration = 800, decimals = 0, delay = 0 } = options;
  const [displayValue, setDisplayValue] = useState(0);
  const previousValueRef = useRef(0);
  const animationRef = useRef<number>();

  useEffect(() => {
    if (targetValue === null || targetValue === undefined) {
      return;
    }

    const startValue = previousValueRef.current;
    const endValue = targetValue;
    const startTime = performance.now() + delay;

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;

      if (elapsed < 0) {
        animationRef.current = requestAnimationFrame(animate);
        return;
      }

      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const easedProgress = 1 - Math.pow(1 - progress, 3);

      const currentValue = startValue + (endValue - startValue) * easedProgress;
      setDisplayValue(Number(currentValue.toFixed(decimals)));

      if (progress < 1) {
        animationRef.current = requestAnimationFrame(animate);
      } else {
        previousValueRef.current = endValue;
      }
    };

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [targetValue, duration, decimals, delay]);

  return displayValue;
}

export function useAnimatedPercentage(
  value: number | null | undefined,
  options?: UseAnimatedValueOptions
): number {
  return useAnimatedValue(value, { ...options, decimals: 1 });
}

export function useAnimatedPrice(
  value: number | null | undefined,
  options?: UseAnimatedValueOptions
): number {
  return useAnimatedValue(value, { ...options, decimals: 2 });
}

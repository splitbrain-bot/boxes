import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Joins class names and resolves conflicting Tailwind utilities.
 *
 * @param inputs The class names, in any form that clsx takes.
 * @returns The joined class names.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

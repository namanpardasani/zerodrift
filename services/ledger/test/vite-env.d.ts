// Minimal typing for the one Vite feature the tests use (avoids depending on vite/client types).
interface ImportMeta {
  glob<T = unknown>(pattern: string, options: { eager: true }): Record<string, T>;
}

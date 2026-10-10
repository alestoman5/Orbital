// Module declarations for files esbuild loads (see esbuild.mjs loaders).
declare module '*.css';
declare module '*.svg' {
  const markup: string;
  export default markup;
}

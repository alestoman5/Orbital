// esbuild's 'file' loader turns these imports into the URL of the copied asset.
declare module '*.woff' {
  const url: string;
  export default url;
}
declare module '*.woff2' {
  const url: string;
  export default url;
}

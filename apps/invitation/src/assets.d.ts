declare module '*.webp' {
  const url: string;
  export default url;
}
declare module '*.svg' {
  const url: string;
  export default url;
}
declare module '*.css';
declare module '@outreach/intake' {
  const module: any;
  export default module;
}
declare module '@outreach/review' {
  const module: any;
  export default module;
}
declare module '@outreach/info' {
  const module: any;
  export default module;
}
declare module '@outreach/storage' {
  const module: any;
  export default module;
}
declare module '@outreach/countries' {
  const module: any;
  export default module;
}

declare module '@outreach/transport' {
  export const mutate: (...args: any[]) => Promise<any>;
}

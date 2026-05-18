interface ImportMetaEnv {
  readonly VITE_NUTRIENT_LICENSE_KEY?: string;
  /** True in production builds (NODE_ENV=production). Injected by Vite. */
  readonly PROD: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Vite's ?worker&inline query: the import returns a Worker constructor class.
// png-encoder.worker.ts is imported this way so viteSingleFile can
// inline the worker blob without producing a separate .js file.
declare module "*?worker&inline" {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}

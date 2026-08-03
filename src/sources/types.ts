export type SourceResult<T> =
  | { status: 'ok'; data: T; fetchedAt: string }
  | { status: 'error'; error: string };

export interface Source<TConfig, TData> {
  readonly id: string;
  fetch(config: TConfig, signal: AbortSignal): Promise<SourceResult<TData>>;
}

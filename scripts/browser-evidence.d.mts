/** Declaration for the untyped ESM module `browser-evidence.mjs`. */

/** One screenshot of a browser run; `problem` replaces the size when it cannot be read as a PNG. */
export interface Screenshot {
  readonly path: string
  readonly width?: number
  readonly height?: number
  readonly problem?: string
}

/** Every PNG under `directory`, with the size read from its own header. */
export declare function readScreenshots(directory: string): Promise<Screenshot[]>

/**
 * Refuse a run whose evidence is missing or unreadable, leaving no artifact
 * directory empty and no promised viewport width without a screenshot; returns
 * the number of screenshots accepted.
 */
export declare function assertScreenshotEvidence(directory: string, viewportWidths: readonly number[]): Promise<number>

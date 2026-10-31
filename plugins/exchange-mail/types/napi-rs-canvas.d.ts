// unpdf's typings name the optional native canvas package for its page-to-image
// helpers. Exchange Mail only extracts text and does not install it.
declare module "@napi-rs/canvas" {
  export type Canvas = unknown;
  export type SKRSContext2D = unknown;
}

declare module "heic-decode" {
  interface Decoded { width: number; height: number; data: Uint8ClampedArray }
  interface Lazy { width: number; height: number; decode(): Promise<Decoded> }
  const decode: { (o: { buffer: Buffer }): Promise<Decoded>; all(o: { buffer: Buffer }): Promise<Lazy[]> };
  export default decode;
}

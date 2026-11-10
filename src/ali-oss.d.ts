declare module 'ali-oss' {
  interface OSSOptions {
    region: string;
    bucket: string;
    accessKeyId: string;
    accessKeySecret: string;
    secure?: boolean;
    timeout?: string | number;
  }
  interface PutResult {
    name: string;
    url: string;
    res: { status: number };
  }
  interface HeadResult {
    status: number;
    meta: Record<string, string>;
  }
  class OSS {
    constructor(options: OSSOptions);
    put(name: string, file: string): Promise<PutResult>;
    head(name: string): Promise<HeadResult>;
  }
  export = OSS;
}

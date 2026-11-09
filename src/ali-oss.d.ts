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
  class OSS {
    constructor(options: OSSOptions);
    put(name: string, file: string): Promise<PutResult>;
  }
  export = OSS;
}

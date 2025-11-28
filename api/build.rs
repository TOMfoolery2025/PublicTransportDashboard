use std::env;
use std::path::Path;
use protoc_fetcher::protoc;

fn main() {
    let protoc_version = "33.1";
    let out_dir = env::var("OUT_DIR").unwrap();
    let protoc_path = protoc(protoc_version, Path::new(&out_dir)).unwrap();
    unsafe { env::set_var("PROTOC", protoc_path); }
    prost_build::compile_protos(
        &["src/proto/transit_realtime.proto"],
        &["proto"],
    ).unwrap();
}
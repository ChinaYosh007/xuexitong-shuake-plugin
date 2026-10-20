import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/shared/sha256";

describe("sha256Hex", () => {
  it("matches FIPS 180-4 test vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
    );
  });

  it("hashes multi-block UTF-8 input deterministically", () => {
    const text = "学习通 AI 学习助手".repeat(40);
    expect(sha256Hex(text)).toBe(sha256Hex(text));
    expect(sha256Hex(text)).toHaveLength(64);
  });
});

import { describe, expect, it } from "vitest";
import { JsonlDecoder } from "../../src/rpc/jsonl";

describe("JsonlDecoder", () => {
  it("splits_only_on_newline", () => {
    const decoder = new JsonlDecoder();
    const records = decoder.push(Buffer.from(JSON.stringify({ a: "x y z" }) + "\n" + '{"b":2}\n'));
    expect(records).toEqual([{ a: "x y z" }, { b: 2 }]);
  });

  it("buffers_partial_tail", () => {
    const decoder = new JsonlDecoder();
    expect(decoder.push(Buffer.from('{"a":'))).toEqual([]);
    expect(decoder.push(Buffer.from('1}\n{"b"'))).toEqual([{ a: 1 }]);
    expect(decoder.push(Buffer.from(":2}\n"))).toEqual([{ b: 2 }]);
  });

  it("strips_cr", () => {
    expect(new JsonlDecoder().push(Buffer.from('{"a":1}\r\n'))).toEqual([{ a: 1 }]);
  });

  it("reassembles_multibyte_characters_split_across_chunks", () => {
    const bytes = Buffer.from('{"a":"я"}\n');
    const cut = bytes.indexOf(0xd1) + 1;
    const decoder = new JsonlDecoder();
    expect(decoder.push(bytes.subarray(0, cut))).toEqual([]);
    expect(decoder.push(bytes.subarray(cut))).toEqual([{ a: "я" }]);
  });

  it("skips_an_oversize_record_and_keeps_decoding", () => {
    const decoder = new JsonlDecoder(10);
    expect(decoder.push(Buffer.from(`{"a":"${"x".repeat(20)}"}\n{"b":2}\n`))).toEqual([{ b: 2 }]);
  });

  it("skips_an_oversize_record_split_across_chunks_until_the_next_newline", () => {
    const decoder = new JsonlDecoder(10);
    expect(decoder.push(Buffer.from('{"a":"xxxx'))).toEqual([]);
    expect(decoder.push(Buffer.from("xxxxxxxxxx"))).toEqual([]);
    expect(decoder.push(Buffer.from('xx"}\n{"b"'))).toEqual([]);
    expect(decoder.push(Buffer.from(":2}\n"))).toEqual([{ b: 2 }]);
  });

  it("reports_the_size_of_each_dropped_record", () => {
    const dropped: number[] = [];
    const decoder = new JsonlDecoder(10, (chars) => dropped.push(chars));
    expect(decoder.push(Buffer.from('{"a":"xxxx'))).toEqual([]);
    expect(decoder.push(Buffer.from("xxxxxxxxxx"))).toEqual([]);
    expect(decoder.push(Buffer.from('xx"}\n{"b":2}\n{"c":"yyyyyyyyyyyy"}\n'))).toEqual([{ b: 2 }]);
    expect(dropped).toEqual([24, 20]);
  });

  it("keeps_a_record_of_exactly_the_limit", () => {
    expect(new JsonlDecoder(7).push(Buffer.from('{"a":1}\n'))).toEqual([{ a: 1 }]);
  });

  it("does_not_split_on_line_separators", () => {
    const decoder = new JsonlDecoder();
    expect(decoder.push(Buffer.from('{"a":"x\u2028y\u2029z"}\n'))).toEqual([{ a: "x\u2028y\u2029z" }]);
  });

  it("decodes_many_small_chunks_of_one_large_record_in_linear_time", () => {
    const decoder = new JsonlDecoder();
    const piece = Buffer.from("x".repeat(1_000));
    const started = performance.now();
    expect(decoder.push(Buffer.from('{"a":"'))).toEqual([]);
    for (let index = 0; index < 5_000; index++) decoder.push(piece);
    const [record] = decoder.push(Buffer.from('"}\n')) as { a: string }[];
    expect(record?.a.length).toBe(5_000_000);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

import { describe, expect, it } from "vitest";

import { readErrorMessage, shortenDigest } from "./helpers.js";

describe(shortenDigest, () => {
  it.each([
    { digest: "12345", expectedDigest: "12345" },
    { digest: "123456789", expectedDigest: "1234567" },
    { digest: "algorithm:12345", expectedDigest: "algorithm:12345" },
    { digest: "algorithm:123456789", expectedDigest: "algorithm:1234567" },
  ])('`shortenDigest("$digest")` → "$expectedDigest"', ({ digest, expectedDigest }) => {
    expect.assertions(1);
    expect(shortenDigest(digest)).toBe(expectedDigest);
  });
});

describe(readErrorMessage, () => {
  it("Reports an error by its message, without the class name in front", () => {
    expect.hasAssertions();

    expect(readErrorMessage(new TypeError("the payload didn't decode"))).toBe("the payload didn't decode");
  });

  it("Stringifies anything that isn't an error, since a dependency may throw whatever it likes", () => {
    expect.hasAssertions();

    expect([readErrorMessage("a bare string"), readErrorMessage(42), readErrorMessage(null)]).toStrictEqual([
      "a bare string",
      "42",
      "null",
    ]);
  });
});

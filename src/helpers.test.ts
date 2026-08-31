import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { isFileNotFound, readErrorMessage, shortenDigest } from "./helpers.js";

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

describe(isFileNotFound, () => {
  it("Recognises the rejection a missing path actually produces", async () => {
    expect.hasAssertions();

    const rejection = await readFile("/renovate-changesets/definitely/not/here").catch((error: unknown) => error);

    expect([isFileNotFound(rejection)]).toStrictEqual([true]);
  });

  it("Refuses an error that failed for some other reason", async () => {
    expect.hasAssertions();

    // A directory read as a file rejects with EISDIR, not ENOENT.
    const rejection = await readFile("/").catch((error: unknown) => error);

    expect([isFileNotFound(rejection), isFileNotFound(new Error("plain"))]).toStrictEqual([false, false]);
  });

  it("Refuses anything that isn't an error, including a bare object wearing the code", () => {
    expect.hasAssertions();

    expect([
      isFileNotFound({ code: "ENOENT" }),
      isFileNotFound("ENOENT"),
      isFileNotFound(null),
      // eslint-disable-next-line unicorn/no-useless-undefined -- The absent case is one of the inputs under test.
      isFileNotFound(undefined),
    ]).toStrictEqual([false, false, false, false]);
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

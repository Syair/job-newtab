import { describe, expect, it } from "vitest";
import { isUsLocation, matchesLocation, matchesRole, matchesSeniority } from "../filter";
import { EMPTY_PROFILE, type JobProfile } from "../profile";

const profile = (over: Partial<JobProfile>): JobProfile => ({ ...EMPTY_PROFILE, ...over });

describe("matchesRole", () => {
  it("matches every role word as a word prefix", () => {
    expect(matchesRole("Senior Software Engineering Manager, Payments", ["Software Engineer"])).toBe(true);
    expect(matchesRole("Software Sales Representative", ["Software Engineer"])).toBe(false);
  });

  it("normalizes common spelling variants", () => {
    expect(matchesRole("Front-End Engineer", ["Frontend Engineer"])).toBe(true);
    expect(matchesRole("Machine Learning Engineer", ["ML Engineer"])).toBe(true);
    expect(matchesRole("Sr. Full Stack Developer", ["Fullstack Engineer"])).toBe(true);
  });

  it("matches any of several roles", () => {
    expect(matchesRole("Product Designer", ["Software Engineer", "Product Designer"])).toBe(true);
  });
});

describe("matchesSeniority", () => {
  it("drops internships unless internships are wanted", () => {
    expect(matchesSeniority("Software Engineer Intern", ["senior"])).toBe(false);
    expect(matchesSeniority("Software Engineer Intern", ["intern"])).toBe(true);
    expect(matchesSeniority("Software Engineer", ["intern"])).toBe(false);
    expect(matchesSeniority("Software Engineer", [])).toBe(true);
  });
});

describe("isUsLocation", () => {
  it.each([
    ["San Francisco, CA", true],
    ["Remote from the US", true],
    ["Seattle, San Francisco, New York City", true],
    ["New York", true],
    ["Dublin", false],
    ["London, UK", false],
  ])("%s -> %s", (location, expected) => {
    expect(isUsLocation(location)).toBe(expected);
  });

  it("trusts an explicit country", () => {
    expect(isUsLocation("London", "US")).toBe(true);
    expect(isUsLocation("New York", "GB")).toBe(false);
  });
});

describe("matchesLocation", () => {
  it("matches listed metros, including abbreviations", () => {
    const p = profile({ locations: ["San Francisco, CA"], remoteOk: false });
    expect(matchesLocation({ location: "SF, NYC, SEA, CHI", remote: false }, p)).toBe(true);
    expect(matchesLocation({ location: "Austin, TX", remote: false }, p)).toBe(false);
  });

  it("accepts US or unlabeled remote jobs, not foreign remote ones", () => {
    const p = profile({ locations: [], remoteOk: true });
    expect(matchesLocation({ location: "Remote", remote: true }, p)).toBe(true);
    expect(matchesLocation({ location: "Remote - US", remote: true }, p)).toBe(true);
    expect(matchesLocation({ location: "Remote, Canada", remote: true }, p)).toBe(false);
    expect(matchesLocation({ location: "Remote", remote: true, country: "GB" }, p)).toBe(false);
  });

  it("accepts any US location when anywhereInUS is on", () => {
    const p = profile({ locations: [], remoteOk: false, anywhereInUS: true });
    expect(matchesLocation({ location: "Denver, CO", remote: false }, p)).toBe(true);
    expect(matchesLocation({ location: "Berlin", remote: false }, p)).toBe(false);
  });
});

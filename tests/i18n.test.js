import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { availableLanguages, defaultLanguage, label, translate } from "../js/i18n.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AMB = JSON.parse(readFileSync(path.join(HERE, "fixtures", "amb_asha_visit.spec.json"), "utf8"));
const byName = (name) => AMB.nodes.find((n) => n.name === name);

test("label() returns the Hindi string when lang is hi", () => {
  assert.equal(label(byName("district"), "hi"), "ज़िला");
  assert.equal(label(byName("asha_name"), "hi"), "आशा का नाम");
});

test("label() returns the English string when lang is en", () => {
  assert.equal(label(byName("district"), "en"), "District");
});

test("label() falls back to the default language when a translation is missing", () => {
  const node = { name: "q", label: { hi: "हिंदी", en: "English" } };
  assert.equal(label(node, "bn", "hi"), "हिंदी");
  assert.equal(label(node, "bn", "en"), "English");
});

test("label() falls back to the first non-empty translation when the default is missing too", () => {
  assert.equal(label({ label: { en: "", hi: "हिंदी" } }, "bn"), "हिंदी");
  assert.equal(label({ label: { hi: "हिंदी" } }, "en"), "हिंदी");
});

test("an empty translation in the chosen language falls back rather than showing nothing", () => {
  assert.equal(label({ label: { hi: "हिंदी", en: "" } }, "en", "hi"), "हिंदी");
});

test("a single-language form reads label[lang] with no branch", () => {
  const node = { label: { default: "Name" } };
  const spec = { languages: ["default"], default_language: "default" };
  assert.equal(label(node, availableLanguages(spec)[0]), "Name");
});

test("label() of a node with no label, or no node, is the empty string and never throws", () => {
  assert.equal(label({ name: "n" }, "hi"), "");
  assert.equal(label({ label: null }, "hi"), "");
  assert.equal(label({ label: {} }, "hi"), "");
  assert.equal(label(undefined, "hi"), "");
  assert.equal(label(null, "hi"), "");
});

test("a plain string label is returned as is", () => {
  assert.equal(label({ label: "Just text" }, "hi"), "Just text");
});

test("translate() reads any translatable field: hint, constraint_message, a choice", () => {
  const age = AMB.nodes.find((n) => n.name === "children").children.find((n) => n.name === "child_age_months");
  assert.equal(translate(age.hint, "en", "hi"), "6 to 59 months");
  assert.equal(translate(age.constraint_message, "hi", "hi"), "उम्र छह से उनसठ महीने के बीच होनी चाहिए");
  assert.equal(translate(AMB.choices.district[0].label, "hi"), "पटना");
  assert.equal(translate(undefined, "hi"), "");
});

test("a translation is not inherited from the prototype chain", () => {
  assert.equal(label({ label: {} }, "constructor"), "");
  assert.equal(label({ label: { hi: "x" } }, "__proto__", "hi"), "x");
});

test("availableLanguages() lists the languages of the compiled spec, default first", () => {
  assert.deepEqual(availableLanguages(AMB), ["hi", "en"]);
});

test("availableLanguages() puts the default language first even when it is listed later", () => {
  assert.deepEqual(availableLanguages({ languages: ["en", "hi"], default_language: "hi" }), ["hi", "en"]);
});

test("availableLanguages() gives a single-language form as default", () => {
  assert.deepEqual(availableLanguages({ languages: ["default"], default_language: "default" }), ["default"]);
});

test("availableLanguages() of a spec with no languages is default, never empty", () => {
  assert.deepEqual(availableLanguages({}), ["default"]);
  assert.deepEqual(availableLanguages({ languages: [] }), ["default"]);
  assert.deepEqual(availableLanguages(undefined), ["default"]);
});

test("availableLanguages() returns a copy the caller may change", () => {
  const spec = { languages: ["hi", "en"], default_language: "hi" };
  availableLanguages(spec).push("bn");
  assert.deepEqual(spec.languages, ["hi", "en"]);
});

test("defaultLanguage() is the spec's default, or the first language, or default", () => {
  assert.equal(defaultLanguage(AMB), "hi");
  assert.equal(defaultLanguage({ languages: ["en", "hi"] }), "en");
  assert.equal(defaultLanguage({}), "default");
  assert.equal(defaultLanguage({ languages: ["en"], default_language: "zz" }), "en");
});

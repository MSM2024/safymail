import test from "node:test";
import assert from "node:assert/strict";
import { assessInboundRisk, htmlToPlainText } from "./inbound";

test("converts HTML-only email bodies to readable plain text", () => {
  const result = htmlToPlainText("<html><head><style>.x{display:none}</style></head><body><h1>Hello</h1><p>Europe &amp; partners</p><p>Line 2<br>Line 3</p></body></html>");
  assert.equal(result, "Hello\nEurope & partners\nLine 2\nLine 3");
});

test("removes scripts, styles, and markup instead of exposing executable HTML", () => {
  const result = htmlToPlainText('<p>Safe</p><script>alert("x")</script><style>body{color:red}</style><img src=x onerror="alert(1)">');
  assert.equal(result, "Safe");
  assert.equal(result.includes("<script"), false);
  assert.equal(result.includes("onerror"), false);
});

test("decodes numeric entities and limits output length", () => {
  assert.equal(htmlToPlainText("A&#32;B &#x1F600;"), "A B 😀");
  assert.equal(htmlToPlainText("<p>" + "x".repeat(210000) + "</p>").length, 200000);
});

test("trusts Cloudflare Authentication-Results and flags authentication failures", () => {
  const result = assessInboundRisk({
    subject: "Invoice",
    text: "Please review the attached invoice.",
    html: "<p>Invoice</p>",
    authenticationResults: "mx.cloudflare.net; spf=fail; dkim=pass; dmarc=fail"
  });
  assert.equal(result.score, 5);
  assert.match(result.reasons.join(" "), /SPF no superó/);
  assert.match(result.reasons.join(" "), /DMARC no superó/);
});

test("does not trust sender-supplied Authentication-Results headers", () => {
  const result = assessInboundRisk({
    subject: "Hello",
    text: "Normal message",
    html: "<p>Hello</p>",
    authenticationResults: "attacker.example; spf=fail; dmarc=fail"
  });
  assert.equal(result.score, 0);
  assert.equal(result.reasons.length, 0);
});

test("flags suspicious shortened links and common phishing language", () => {
  const result = assessInboundRisk({
    subject: "Verify your account urgently",
    text: "Your account suspended. Reset your password.",
    html: '<a href="https://bit.ly/example">Open</a>',
    authenticationResults: null
  });
  assert.ok(result.score >= 3);
  assert.match(result.reasons.join(" "), /enlaces acortados/);
  assert.match(result.reasons.join(" "), /suplantación/);
});

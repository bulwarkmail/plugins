/**
 * Auto Tag Plugin — automatically tags emails based on rules.
 *
 * Demonstrates:
 * - Using onNewEmailReceived hook
 * - Using plugin settings for configurable rules
 * - Using toast for user feedback
 * - Pattern matching on email properties
 */

// Tag rules - each has a name, a check function, and a keyword to apply
function buildRules(settings) {
  const rules = [];

  if (settings.tagNewsletter !== false) {
    rules.push({
      name: "Newsletter",
      keyword: "$newsletter",
      check: (email) => {
        // Check for mailing list headers or unsubscribe links
        const from = (email.from || "").toLowerCase();
        const subject = (email.subject || "").toLowerCase();
        return (
          from.includes("newsletter") ||
          from.includes("noreply") ||
          from.includes("no-reply") ||
          subject.includes("unsubscribe") ||
          subject.includes("weekly digest") ||
          subject.includes("monthly update")
        );
      },
    });
  }

  if (settings.tagInvoice !== false) {
    rules.push({
      name: "Invoice",
      keyword: "$invoice",
      check: (email) => {
        const subject = (email.subject || "").toLowerCase();
        return (
          subject.includes("invoice") ||
          subject.includes("receipt") ||
          subject.includes("payment confirmation") ||
          subject.includes("order confirmation") ||
          subject.includes("billing statement")
        );
      },
    });
  }

  if (settings.tagGithub !== false) {
    rules.push({
      name: "GitHub",
      keyword: "$github",
      check: (email) => {
        const from = (email.from || "").toLowerCase();
        return (
          from.includes("notifications@github.com") ||
          from.includes("noreply@github.com")
        );
      },
    });
  }

  return rules;
}

export function activate(api) {
  const rules = buildRules(api.plugin.settings);

  if (rules.length === 0) {
    api.log.info("Auto Tag: no rules enabled");
    return;
  }

  api.log.info(`Auto Tag: ${rules.length} rule(s) active`);

  // Track stats
  let tagged = api.storage.get("totalTagged") || 0;

  const sub = api.hooks.onNewEmailReceived((notification) => {
    for (const rule of rules) {
      if (rule.check(notification)) {
        api.log.info(
          `Auto Tag: "${notification.subject}" matched rule "${rule.name}"`,
        );
        tagged++;
        api.storage.set("totalTagged", tagged);
        // Note: actual keyword application would require JMAP write access
        // This demonstrates the pattern — in production, you'd call a JMAP method
        break; // Apply first matching rule only
      }
    }
  });

  return {
    dispose: () => {
      sub.dispose();
      api.log.info(`Auto Tag deactivated. Total tagged: ${tagged}`);
    },
  };
}

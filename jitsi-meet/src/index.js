/**
 * Jitsi Meet Plugin — adds "Add Jitsi Meeting" to calendar events.
 *
 * Calls the server-side /api/jitsi endpoint to generate meeting URLs.
 * All configuration (Jitsi URL, JWT secret) is handled server-side,
 * so no plugin configuration step is needed.
 */

export function activate(api) {
  const disposables = [];

  disposables.push(
    api.ui.registerCalendarEventAction({
      id: "add-jitsi-meeting",
      label: "Add Jitsi Meeting",
      order: 10,
      onClick: async (eventData, { setVirtualLocation }) => {
        try {
          const authHeaders = api.auth.getHeaders();
          const response = await fetch("/api/jitsi", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders },
            body: JSON.stringify({ eventTitle: eventData.title || "meeting" }),
          });

          if (!response.ok) {
            throw new Error(`Server responded with ${response.status}`);
          }

          const data = await response.json();
          setVirtualLocation(data.url);
          api.toast.success("Jitsi meeting link added");
        } catch (err) {
          api.log.error("Failed to create Jitsi meeting link", err);
          api.toast.error("Failed to create Jitsi meeting link");
        }
      },
    }),
  );

  api.log.info("Jitsi Meet plugin activated");

  return {
    dispose: () => {
      disposables.forEach((d) => d.dispose());
    },
  };
}

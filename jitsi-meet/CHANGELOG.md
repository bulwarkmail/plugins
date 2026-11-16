# Changelog

## Unreleased

## 1.4.0 (2026-11-16)

### Security
- The meeting link in the event and its invitations no longer carries the organizer's Jitsi token. Until now every attendee could join with the organizer's name and moderator rights for 24 hours. Opening an older event in the form takes the token out of its link; save it to send the clean link. The sidecar has to be updated too #12

### Added
- Join as moderator: with JWT auth on, the organizer gets a one-hour moderator link for their own meeting, opened in a new tab and never stored in the event. Attendees join with the plain link, so Jitsi has to let guests in

## 1.3.1 (2026-10-31)

### Added
- Screenshots in the extension directory

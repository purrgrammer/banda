---
service: Gmail
url: https://gmail.googleapis.com/gmail/v1/users/me
api: gmail
auth: oauth
client: google
scopes: [https://www.googleapis.com/auth/gmail.readonly]
ask: always
account: get_profile.emailAddress
reads: [get_profile, get_labels, search_messages, get_message, get_thread]
---
Read your Gmail inbox and conversations. Search with bounded pagination, inspect message headers and plain text, and read
a complete thread. Search results include Gmail message links; use them in the answer to show email cards in chat.
The owner starts with read-only access. Sending and mailbox changes are separate tools that always ask for approval;
they require the owner to add the matching Google scope and sign in again. The daemon keeps credentials outside the
store and the agent's computer.

```json
{
	"needs": {
		"send_message": ["https://www.googleapis.com/auth/gmail.send"],
		"mailbox_archive": ["https://www.googleapis.com/auth/gmail.modify"],
		"mailbox_trash": ["https://www.googleapis.com/auth/gmail.modify"],
		"mailbox_mark_read": ["https://www.googleapis.com/auth/gmail.modify"],
		"mailbox_mark_unread": ["https://www.googleapis.com/auth/gmail.modify"],
		"mailbox_add_label": ["https://www.googleapis.com/auth/gmail.modify"],
		"mailbox_remove_label": ["https://www.googleapis.com/auth/gmail.modify"]
	},
	"objects": {
		"email": {
			"card": "email",
			"name": "{id}",
			"urls": ["https://mail.google.com/mail/u/0/#all/{id}"],
			"ids": ["gmail/{id}"],
			"reads": {
				"message": { "tool": "get_message", "args": { "message_id": "{id}" } }
			},
			"fields": {
				"from": "message.from",
				"to": "message.to",
				"subject": "message.subject",
				"date": "message.date",
				"snippet": "message.snippet",
				"body": "message.body",
				"attachments": "message.attachments",
				"unread": "message.unread",
				"url": "message.url"
			},
			"writes": [
				{ "tool": "mailbox_archive", "id": { "id": "message_id" }, "verb": "Archive" },
				{ "tool": "mailbox_trash", "id": { "id": "message_id" }, "verb": "Move to Trash" },
				{ "tool": "mailbox_mark_read", "id": { "id": "message_id" }, "verb": "Mark read" },
				{ "tool": "mailbox_mark_unread", "id": { "id": "message_id" }, "verb": "Mark unread" },
				{ "tool": "mailbox_add_label", "id": { "id": "message_id" }, "verb": "Add label" },
				{ "tool": "mailbox_remove_label", "id": { "id": "message_id" }, "verb": "Remove label" }
			]
		}
	}
}
```

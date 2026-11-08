---
service: Google Contacts
url: https://people.googleapis.com/v1
api: contacts
auth: oauth
client: google
scopes: [https://www.googleapis.com/auth/contacts.readonly, https://www.googleapis.com/auth/contacts.other.readonly, https://www.googleapis.com/auth/userinfo.email]
account: get_profile.email
reads: [get_profile, search_contacts, search_other_contacts, get_contact]
---
Find people in your Google Contacts, and among the people you have emailed, with their addresses and phone numbers,
so "email Ana" or "invite Bo" reaches the right address. Reference people as `contacts/<id>` in the answer, as the
searches return them, to show their contact cards in chat. The owner starts with read-only access. Adding, changing and deleting a contact are separate tools that always ask for
approval, as a draft showing what will be set; they require the owner to add the matching Google scope and sign in
again. The daemon keeps credentials outside the store and the agent's computer.

```json
{
	"needs": {
		"create_contact": ["https://www.googleapis.com/auth/contacts"],
		"update_contact": ["https://www.googleapis.com/auth/contacts"],
		"delete_contact": ["https://www.googleapis.com/auth/contacts"]
	},
	"objects": {
		"contact": {
			"card": "contact",
			"name": "{id}",
			"ids": ["contacts/{id}"],
			"reads": {
				"contact": { "tool": "get_contact", "args": { "contact_id": "{id}" } }
			},
			"follow": {
				"rules": [
					{ "on": "contact.emails[*]", "kind": "added", "does": "tell", "says": "new email {to}" },
					{ "on": "contact.emails[*]", "kind": "removed", "does": "tell", "says": "email {from} removed" },
					{ "on": "contact.phones[*]", "kind": "added", "does": "tell", "says": "new phone {to}" },
					{ "on": "contact.phones[*]", "kind": "removed", "does": "tell", "says": "phone {from} removed" },
					{ "on": "contact.addresses[*]", "kind": "added", "does": "tell", "says": "new address: {to}" },
					{ "on": "contact.addresses[*]", "kind": "removed", "does": "tell", "says": "address removed: {from}" },
					{ "on": "contact.organization", "to": "", "does": "tell", "says": "no longer at {from}" },
					{ "on": "contact.organization", "does": "tell", "says": "now at {to}" },
					{ "on": "contact.title", "to": "", "does": "nothing", "says": "no title" },
					{ "on": "contact.title", "does": "tell", "says": "title: {to}" },
					{ "on": "contact.name", "does": "tell", "says": "renamed: {to}" }
				],
				"ends": {},
				"every": "6h"
			},
			"fields": {
				"name": "contact.name",
				"emails": "contact.emails",
				"phones": "contact.phones",
				"organization": "contact.organization",
				"title": "contact.title",
				"other": "contact.other",
				"photo": "contact.photo",
				"url": "contact.url"
			},
			"writes": [
				{ "tool": "update_contact", "id": { "id": "contact_id" }, "verb": "Change" },
				{ "tool": "delete_contact", "id": { "id": "contact_id" }, "verb": "Delete" }
			]
		}
	}
}
```

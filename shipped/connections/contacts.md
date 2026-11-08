---
service: Google Contacts
url: https://people.googleapis.com/v1
api: contacts
auth: oauth
client: google
scopes: [https://www.googleapis.com/auth/contacts.readonly, https://www.googleapis.com/auth/contacts.other.readonly, https://www.googleapis.com/auth/userinfo.email]
ask: always
account: get_profile.email
reads: [get_profile, search_contacts, search_other_contacts, get_contact]
---
Find people in your Google Contacts, and among the people you have emailed, with their addresses and phone numbers,
so "email Ana" or "invite Bo" reaches the right address. Reference people as `contacts/<id>` in the answer, as the
searches return them, to show their contact cards in chat. Access is read-only: nothing here adds, changes or removes a
person. The daemon keeps credentials outside the store and the agent's computer.

```json
{
	"objects": {
		"contact": {
			"card": "contact",
			"name": "{id}",
			"ids": ["contacts/{id}"],
			"reads": {
				"contact": { "tool": "get_contact", "args": { "contact_id": "{id}" } }
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
			}
		}
	}
}
```

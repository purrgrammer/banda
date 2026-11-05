---
name: catch-me-up
description: "Catch the owner up on what changed in this chat since their last message, in plain words. List every item waiting on them with what they need to decide it from the reply alone. Use for /catch-me-up."
disable-model-invocation: true
---

# Catch me up

Catch the owner up on what changed since the last message they wrote in this chat before `/catch-me-up`, and help them understand each change, not only where it stands. Then lay out every call waiting on them so they can make it from your reply alone. Routine wakes, messages from other agents and results you fetched are not their messages. Assume the owner remembers their last message and nothing after it.

Speak plainly: short sentences, no jargon, like one person catching up another. Say what changed for the owner, not how you did it. Say "the report is ready", not "the run settled". Leave out ids, file paths, commands, hashes and counts unless the owner needs one to act. Call each agent, group, routine, artifact or thing in a connection by the name the owner sees, not by a label you invented. If a fact needs context to make sense, give the context or leave the fact out.

## Gather what changed

Keep this turn read-only: do not send, write, schedule, propose or start anything, apart from a picture as below. Collect, since that message:

- What you did in this chat, and what came of it.
- Each routine of yours that ran: when, and what it found. A run that found nothing worth saying is one line at most; a run that failed or stalled is news.
- Artifacts made or changed: what each is for, and its name so the owner can open it.
- Messages from other agents. If you are the band's first agent, also read what the rest of the band did where you can read it: who did what, and what any of it means for the owner.
- Every item waiting on the owner, even one raised before their last message: drafts waiting for approval, questions an agent asked and nobody answered, changes waiting to be allowed (an agent, a routine, a skill), and routines or connections you suggested and the owner has not set up.

Check the current state of each thing before you report it: a draft may have been approved, a question answered, a routine run again. Check each number you will give against the facts it comes from, and say so when you correct one.

An action item is a call only the owner can make: approving or declining a draft, answering a question, allowing a change, a choice between options, signing in, or anything that cannot be undone. Work you can still do yourself is not an action item. Never make up a call to fill the reply. A step the owner did not ask for and the work does not need is not an action item, unless it cannot be undone and waits on the owner: give it one line.

One call can cover many items, such as several drafts of the same kind. For each item, collect what it is (the draft as stored, the question as asked), what it changes for the owner, the evidence behind your pick, its risk, and your pick. Write "unknown" for a fact the call needs that you do not know. Never invent a fact, a number or a result.

## Write the reply

Spend words on the calls, not on the story. Keep what happened under 100 words, and shorter when less happened. Leave out work that changed nothing for the owner. Give each item about 30 words. The reply grows with the number of items: two items need well under 150 words in all, and thirty need far more. Never cut items or shrink them to stay under a word count: no count in place of a list, and no name in place of an item. The reply alone must be enough to decide.

Open with one short sentence that names what waits on the owner, or says nothing does. If nothing happened and nothing waits on the owner, say so and stop.

Then sum up what happened in one short bullet per thing the owner asked for or should know: what came of it, and whether it is done, still running, failed, or not checked. Write each line the way you would say it out loud: "The morning check found two new invoices", not "Routine: done". Each line must stay true when read alone. Never mark something done that still waits on the owner, and leave out anything the action items say. Then name in one line any work left that you can do yourself.

Then list the action items, riskiest first. Ask the call the owner owns, such as approve, answer, allow or pick, and give your pick. A step you would take first goes in your pick. So does anything that must happen first, and anything that cannot be undone. Name the agent, draft, routine or artifact each call is about.

Fit the shape to the call. A call about one item is one bullet: the call, your pick, what it changes for the owner, the evidence behind your pick, and its risk. When items share a call, write the call and your pick once, then give each item its own bullet: its name, what it changes, the evidence, and its risk. Give each item's risk even when it is low, such as "Low risk: it only reads your calendar." Say what waiting costs only when it is more than a delay, such as a deadline or a missed reply.

For a call between options, give every option, each with what it gets the owner and what it costs, and the current state when there is one. Those costs are the call's risk, so add no separate risk line.

## Pictures

Most catch-ups need none. When something is easier to grasp as a picture than as sentences, such as how several agents' work fits together or two options side by side, and you can make a page artifact, make one small page from facts you have and name it in the reply. Never draw a status list or a list of action items, never give a fact twice, and never draw a screen you did not see. A table is not a picture.

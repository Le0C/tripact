# readme draft

If you operate a software factory or do spec driven development, I wrote a CLI tool for your agents, check it out!

Tripact is a deterministic traceability engine. It ties together your specs, tests & documentation wih stable identifiers that survive rewording or reformatting. 

It does this programmatically (i.e. without an LLM) - if something is missing or there is a mismatch between specs/tests/docs, it emits a list of tasks which describe needs to be done to bring things in sync. If somethings is ambiguous, it escalates judgement to the task queue for intelligent evaluation.

With tripact, you (or your agents) can:

- Programatically check for drift between spec/docs/tests
- Audit a claim, showing it's history from inception till now
- Bootstrap missing docs/tests based on existing specs
- Generate an ordered task queue based on new/changed specs
- Propose links between existing specs + tests

My goal with tripact is to make tracing code changes simple and cheap, for you or your agents. 

If you are primarily writing specs to hand off to agents, then tripact gives your agents less room for error or omission.

If you are shipping faster with AI, then eventually something might break or you might get asked why something was built & when it was tested. Tripact gives you a way to answer those questions decisively.
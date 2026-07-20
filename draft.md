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

My goal with tripact is twofold: 1) to make tracing code changes simple and cheap, for you or your agents. 2) to give you a reliable way to enforce product specifcations, giving you or your agents less room for error or omission.

If you are shipping faster with AI, then eventually something might break or you might get asked why something was built & when it was tested. Tripact gives you a way to answer those questions decisively.

Check it out here:

---

Today I am launching **tripact** (github), which is a traceability engine for spec driven development. It ships a CLI tool, and it does a few things:

- Ties together your specs, tests & documentation into claims with stable identifiers that survive reformatting or rewording
- Escalates ambiguous claims to a task queue for intelligent evaluation
- Generates ordered task queues when specs are added or changed

Tripact is a plain old program, i.e. it doesn't use any LLM under the hood. It is designed to be usable by agents, in a harness, in a loop or in a software factory (if you've got the token budget!).

It does this by writing output in JSON, having stable exit codes (0=level, 1=drift, 2=error) and emitting skill files for specific tasks in the lifecycle.
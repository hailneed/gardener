# Fixture instructions

This file exists for CI. It is deliberately broken so that `gardener --audit`
has real findings to produce; it is not an example of a good instruction file.

Kept in English on purpose: the CI language gate asserts that the default report
contains no Turkish, and quoted fixture text would make that assertion ambiguous.

@./extra.md
@./does-not-exist.md

## Rules

- All UI strings must go through MessageService and no hardcoded text is allowed.
- Read `docs/nonexistent-guide.md` before you change the database schema.
- Be careful when you touch anything here.

HDAB configuration
==================

All HDAB entries live in `hdab_configs.json` in this directory.  The file is
imported statically at module load time (like `decision_rules.json`) so no
filesystem access or `static_files` entry in `supabase/config.toml` is needed.
Adding a country means adding one entry to the `hdabs` array — no code change.

Structure of `hdab_configs.json`:

```json
{
  "default": "at",
  "hdabs": [ { ...at }, { ...de }, ... ]
}
```

`default` names the fallback code used when no `x-hdab` / `?hdab` is supplied.
If the file fails validation at startup the module logs the error and falls back
to the built-in Austria config so that requests without `x-hdab` keep working.

`GET /requests/hdab` returns `{ configs: [...] }` with the public fields only.
Use `x-hdab: de` or `?hdab=de` on requests routes; the header wins, and the
default is `at`.  Unknown codes return 400.  Decisions and previews report the
base rules version followed by `+<code>`.

`languages` and `display_language` use the supported UI dictionaries (`de`, `en`).
Branding uses six-digit hex `primary` and `accent` colours.  Contact is an email.
Unknown fields at every object level fail validation.

`extra_prohibited` contains additional Art. 54 rules.  `phrases` are
case-insensitive regular expressions using the base engine's negation handling.
Each rule needs a unique `N-<CODE>-...` ID, label, article_ref `54`, examples
and counter_examples.  The tests exercise those examples for every config.
National matches retain their rule ID and cannot be approved through a staff
override.  Austria's empty rule list preserves the baseline decisions and
existing review behaviour.

Run `deno test -A` and `deno check supabase/functions/requests/index.ts` from
the backend root after editing configuration.

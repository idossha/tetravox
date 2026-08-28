# docs/ — the Tetravox site

GitHub Pages site built with Jekyll from this directory (`baseurl: /tetravox`). Most of the pages here
are the project's actual docs (`ARCHITECTURE.md`, `USER_GUIDE.md`, `AUTOMATION.md`, `TESTING.md`,
`DECISIONS.md`, `ROADMAP.md`, `BENCHMARKS.md`) with Jekyll front matter added — they are the single
source of truth and are meant to be read equally well on GitHub or on the built site.

## Local preview

Use Homebrew Ruby, not the system one:

```sh
export PATH="$(brew --prefix ruby)/bin:$PATH"
cd docs
bundle install --path vendor/bundle
bundle exec jekyll serve   # http://127.0.0.1:4000/tetravox/
```

Or just build once and check the output:

```sh
bundle exec jekyll build   # writes docs/_site/
```

There is no root `pnpm docs:*` script — this is a plain Jekyll site, not part of the pnpm workspace.

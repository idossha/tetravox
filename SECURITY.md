# Security Policy

## Supported versions

Only the latest release on the [Releases page](https://github.com/idossha/tetravox/releases)
receives fixes.

## Reporting a vulnerability

Tetravox is a desktop viewer: it reads files you open and renders them locally, and it does not
talk to the network. The most likely class of issue is a crafted `.nii`, `.msh`, `.gii` or similar
file that crashes the parser or the renderer.

If you believe you have found a security vulnerability, please **do not** open a public GitHub
issue. Email ihaber@wisc.edu with a description and, where possible, a short self-contained
reproducing file. You will normally get a response within a week. Tetravox does not offer bounties.

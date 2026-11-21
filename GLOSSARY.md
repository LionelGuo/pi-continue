# Glossary

- **Partial reply**: An assistant message whose stop reason is `aborted` or `error`. Pi retains it in the transcript, while its shared message filter omits it from provider context.
- **Continuation trigger**: The hidden custom message that starts one new model request. The extension filters it from each provider context and records a context edit to omit it from later session projections.
- **Continuation marker**: A custom session entry shown in the transcript to identify the skipped partial reply. It is not sent to the model.

# pi-continue

Install the extension with Pi:

```sh
pi install npm:@lionel-guo/pi-continue
```

After an assistant reply ends with an aborted or error stop, run `/continue` to ask the current model to generate again from the complete context. The partial reply remains visible in the transcript but is omitted by Pi's shared message filter. A marker records its stop reason and content-block composition. The command does not resume at the next token, and it does not execute tool calls contained in the failed reply.

The command refuses while a reply is running, while messages are queued, when arguments are supplied, or when the latest assistant reply is not aborted or errored.

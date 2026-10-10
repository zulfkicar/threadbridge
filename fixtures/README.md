# Payload provenance

`wire-payloads.json` contains authored full-envelope fixtures following the native Slack Events API and Jira webhook schemas. Identifiers, actors, content, links and credentials are fictional. They are **not recordings from connected accounts**.

The locally inspected company exports define richer Zapier step outputs. In particular, they reference an enriched `user.profile.email`, flattened `all_files[]...` fields, dotted `message.last` keys and assignment/SLA lists. Those findings inform regression contracts without copying customer messages, company routing rules, prompts or tokens.

Native webhook fixtures and export-derived step-output fixtures are distinct. A Zap definition records configuration and mappings. It cannot prove that a provider delivered a particular raw event or accepted a particular write. Live recording parity still requires an authorized sandbox or redacted run recordings.

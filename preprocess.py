"""
Deprecated: the app now sources stops and edges directly from Neo4j.

If you need to regenerate the local graph artifacts, move that logic
into the Neo4j ETL instead of using this script.
"""

if __name__ == "__main__":
    raise SystemExit("Deprecated: data now comes from Neo4j; this script is no longer used.")

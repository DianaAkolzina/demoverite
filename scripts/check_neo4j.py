#!/usr/bin/env python3
"""
Neo4j connectivity checker and quick sanity actions.

Run this on your host (outside Docker) using your venv:

  pip install 'neo4j~=5.28.0'
  python3 scripts/check_neo4j.py --uri neo4j+s://<host> --username neo4j --password '<pass>' --database neo4j

Or rely on env vars:
  NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD, NEO4J_DATABASE

Optional flags:
  --create-sample    Create two Person nodes and a KNOWS relationship
  --query-sample     Query Person->KNOWS graph and print names
  --cleanup-sample   Remove the created sample nodes

Examples:
  python3 scripts/check_neo4j.py --uri bolt+s://33c738dd.databases.neo4j.io \
    --username neo4j --password '...' --database neo4j --create-sample --query-sample
"""
import argparse
import os
import sys
from neo4j import GraphDatabase

# Optional: auto-load .env from repo root so running outside Docker picks up values
try:
  from dotenv import load_dotenv  # type: ignore
  # Look for .env in current working directory and parent
  load_dotenv(dotenv_path=os.path.join(os.getcwd(), '.env'))
  load_dotenv(dotenv_path=os.path.join(os.path.dirname(os.getcwd()), '.env'))
except Exception:
  pass


def parse_args():
  p = argparse.ArgumentParser(description='Neo4j connectivity checker')
  p.add_argument('--uri', default=os.environ.get('NEO4J_URI'))
  p.add_argument('--username', default=os.environ.get('NEO4J_USERNAME', 'neo4j'))
  p.add_argument('--password', default=os.environ.get('NEO4J_PASSWORD'))
  p.add_argument('--database', default=os.environ.get('NEO4J_DATABASE', 'neo4j'))
  p.add_argument('--timeout-ms', type=int, default=int(os.environ.get('NEO4J_CHECK_TIMEOUT_MS', '15000')))
  p.add_argument('--create-sample', action='store_true')
  p.add_argument('--query-sample', action='store_true')
  p.add_argument('--cleanup-sample', action='store_true')
  return p.parse_args()


def main():
  args = parse_args()
  if not args.uri or not args.username or not args.password:
    print('Missing required connection info. Provide --uri, --username, --password or set env NEO4J_URI/USERNAME/PASSWORD', file=sys.stderr)
    sys.exit(2)

  print(f"[neo4j-check] URI={args.uri} db={args.database}")
  driver = GraphDatabase.driver(args.uri, auth=(args.username, args.password))
  try:
    # Connectivity
    driver.verify_connectivity()
    print('[neo4j-check] Connectivity OK')

    # Optional actions
    if args.create_sample:
      summary = driver.execute_query(
        """
        CREATE (a:Person {name: $name})
        CREATE (b:Person {name: $friendName})
        CREATE (a)-[:KNOWS]->(b)
        """,
        name='Alice', friendName='David',
        database_=args.database,
      ).summary
      print(f"[neo4j-check] Created {summary.counters.nodes_created} nodes, {summary.counters.relationships_created} rels")

    if args.query_sample:
      records, summary, keys = driver.execute_query(
        """
        MATCH (p:Person)-[:KNOWS]->(:Person)
        RETURN p.name AS name
        """,
        database_=args.database,
      )
      print(f"[neo4j-check] Query returned {len(records)} records in {summary.result_available_after} ms")
      for r in records:
        print(' -', r.data())

    if args.cleanup_sample:
      summary = driver.execute_query(
        """
        MATCH (p:Person)
        WHERE p.name IN [$a, $b]
        DETACH DELETE p
        """,
        a='Alice', b='David',
        database_=args.database,
      ).summary
      print(f"[neo4j-check] Deleted {summary.counters.nodes_deleted} nodes")

  except Exception as e:
    print('[neo4j-check] FAILED:', e, file=sys.stderr)
    sys.exit(1)
  finally:
    try:
      driver.close()
    except Exception:
      pass


if __name__ == '__main__':
  main()

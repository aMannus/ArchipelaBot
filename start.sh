#!/bin/bash

# Kill if started
export BOTPID=`ps aux | grep 'bot.js' | grep -v grep | awk '{print($2)}'`
if [ -n "$BOTPID" ]; then
  echo "Killing old process "$BOTPID"."
  kill $BOTPID
fi

# Update from git
echo "Pulling latest git version"
git pull

# Start
echo "Starting"
nohup node bot.js > nohup.out 2>&1 &
sleep 1
export BOTPID=`ps aux | grep 'bot.js' | grep -v grep | awk '{print($2)}'`
if [ -n "$BOTPID" ]; then
  echo "Running correctly."
else
  echo "ERROR: Script stopped."
fi

# Code Review

_Started: 2026-08-31_

---

## `a.go`

#### Line 3

trailing spaces in context must survive

```go context
1: package main
2: 
3:     indented
4: 
5: func main() {}
6: 
```

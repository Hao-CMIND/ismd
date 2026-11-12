use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::RwLock;

use crate::store::{DependencyKind, TemplateId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct DependencyEdge {
    pub target: TemplateId,
    pub kind: DependencyKind,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DependencyGraphStats {
    pub nodes: usize,
    pub edges: usize,
}

#[derive(Default)]
struct GraphInner {
    dependencies: HashMap<TemplateId, Vec<DependencyEdge>>,
    reverse_dependents: HashMap<TemplateId, HashSet<TemplateId>>,
}

/// Thread-safe bidirectional dependency graph (`TemplateId -> dependencies` and `reverse_dependents`).
pub struct DependencyGraph {
    inner: RwLock<GraphInner>,
}

impl Default for DependencyGraph {
    fn default() -> Self {
        Self::new()
    }
}

impl DependencyGraph {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(GraphInner::default()),
        }
    }

    /// Replaces `parent`'s outgoing dependency edges and updates `reverse_dependents` accordingly.
    pub fn set_dependencies(&self, parent: TemplateId, edges: Vec<DependencyEdge>) {
        let mut deduped: Vec<DependencyEdge> = Vec::with_capacity(edges.len());
        let mut seen = HashSet::with_capacity(edges.len());
        for edge in edges {
            if seen.insert(edge) {
                deduped.push(edge);
            }
        }

        let mut inner = self.inner.write().expect("dependency graph rwlock poisoned");
        if let Some(old_edges) = inner.dependencies.remove(&parent) {
            for old in old_edges {
                if let Some(rev) = inner.reverse_dependents.get_mut(&old.target) {
                    rev.remove(&parent);
                    if rev.is_empty() {
                        inner.reverse_dependents.remove(&old.target);
                    }
                }
            }
        }

        for edge in &deduped {
            inner
                .reverse_dependents
                .entry(edge.target)
                .or_default()
                .insert(parent);
        }

        if !deduped.is_empty() {
            inner.dependencies.insert(parent, deduped);
        }
    }

    pub fn direct_dependency_edges(&self, id: TemplateId) -> Vec<DependencyEdge> {
        let inner = self.inner.read().expect("dependency graph rwlock poisoned");
        inner.dependencies.get(&id).cloned().unwrap_or_default()
    }

    pub fn direct_dependencies(&self, id: TemplateId) -> Vec<TemplateId> {
        let inner = self.inner.read().expect("dependency graph rwlock poisoned");
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        if let Some(edges) = inner.dependencies.get(&id) {
            for edge in edges {
                if seen.insert(edge.target) {
                    out.push(edge.target);
                }
            }
        }
        out
    }

    pub fn direct_dependents(&self, id: TemplateId) -> Vec<TemplateId> {
        let inner = self.inner.read().expect("dependency graph rwlock poisoned");
        let mut out: Vec<TemplateId> = inner
            .reverse_dependents
            .get(&id)
            .map(|set| set.iter().copied().collect())
            .unwrap_or_default();
        out.sort_unstable();
        out
    }

    /// Returns the transitive closure of `changed` along `reverse_dependents` (cycle-safe, deduplicated).
    pub fn collect_affected(&self, changed: &[TemplateId]) -> Vec<TemplateId> {
        let inner = self.inner.read().expect("dependency graph rwlock poisoned");
        let mut visited: HashSet<TemplateId> = HashSet::with_capacity(changed.len());
        let mut queue: VecDeque<TemplateId> = VecDeque::with_capacity(changed.len());
        let mut ordered: Vec<TemplateId> = Vec::with_capacity(changed.len());

        for &id in changed {
            if visited.insert(id) {
                queue.push_back(id);
                ordered.push(id);
            }
        }

        while let Some(cur) = queue.pop_front() {
            if let Some(rev) = inner.reverse_dependents.get(&cur) {
                let mut sorted_rev: Vec<TemplateId> = rev.iter().copied().collect();
                sorted_rev.sort_unstable();
                for dep in sorted_rev {
                    if visited.insert(dep) {
                        queue.push_back(dep);
                        ordered.push(dep);
                    }
                }
            }
        }

        ordered
    }

    pub fn remove_template(&self, id: TemplateId) {
        let mut inner = self.inner.write().expect("dependency graph rwlock poisoned");
        if let Some(old_edges) = inner.dependencies.remove(&id) {
            for old in old_edges {
                if let Some(rev) = inner.reverse_dependents.get_mut(&old.target) {
                    rev.remove(&id);
                    if rev.is_empty() {
                        inner.reverse_dependents.remove(&old.target);
                    }
                }
            }
        }
        if let Some(parents) = inner.reverse_dependents.remove(&id) {
            for parent in parents {
                if let Some(edges) = inner.dependencies.get_mut(&parent) {
                    edges.retain(|e| e.target != id);
                    if edges.is_empty() {
                        inner.dependencies.remove(&parent);
                    }
                }
            }
        }
    }

    pub fn clear(&self) {
        let mut inner = self.inner.write().expect("dependency graph rwlock poisoned");
        inner.dependencies.clear();
        inner.reverse_dependents.clear();
    }

    pub fn stats(&self) -> DependencyGraphStats {
        let inner = self.inner.read().expect("dependency graph rwlock poisoned");
        let mut nodes: HashSet<TemplateId> =
            HashSet::with_capacity(inner.dependencies.len() + inner.reverse_dependents.len());
        let mut edges = 0usize;
        for (&parent, list) in &inner.dependencies {
            nodes.insert(parent);
            edges += list.len();
            for edge in list {
                nodes.insert(edge.target);
            }
        }
        DependencyGraphStats {
            nodes: nodes.len(),
            edges,
        }
    }
}
